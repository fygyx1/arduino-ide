import { injectable, inject } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common/event';
import { ILogger } from '@theia/core/lib/common/logger';
import { CommandService } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application';
import { RecursiveRequired } from '../../common/types';
import {
  Port,
  Board,
  BoardsService,
  BoardsPackage,
  AttachedBoardsChangeEvent,
  BoardWithPackage,
  BoardUserField,
} from '../../common/protocol';
import { BoardsConfig } from './boards-config';
import { naturalCompare } from '../../common/utils';
import { NotificationCenter } from '../notification-center';
import { StorageWrapper } from '../storage-wrapper';
import { nls } from '@theia/core/lib/common';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';

export const LATEST_VALID_BOARDS_CONFIG = 'latest-valid-boards-config';
export const LATEST_BOARDS_CONFIG = 'latest-boards-config';

@injectable()
export class BoardsServiceProvider implements FrontendApplicationContribution {
  @inject(ILogger)
  protected logger: ILogger;

  @inject(MessageService)
  protected messageService: MessageService;

  @inject(BoardsService)
  protected boardsService: BoardsService;

  @inject(CommandService)
  protected commandService: CommandService;

  @inject(NotificationCenter)
  protected notificationCenter: NotificationCenter;

  @inject(FrontendApplicationStateService)
  private readonly appStateService: FrontendApplicationStateService;

  protected readonly onBoardsConfigChangedEmitter =
    new Emitter<BoardsConfig.Config>();
  protected readonly onAvailableBoardsChangedEmitter = new Emitter<
    AvailableBoard[]
  >();
  protected readonly onAvailablePortsChangedEmitter = new Emitter<Port[]>();

  /**
   * Used for the auto-reconnecting. Sometimes, the attached board gets disconnected after uploading something to it.
   * It happens with certain boards on Windows. For example, the `MKR1000` boards is selected on post `COM5` on Windows,
   * perform an upload, the board automatically disconnects and reconnects, but on another port, `COM10`.
   * We have to listen on such changes and auto-reconnect the same board on another port.
   * See: https://arduino.slack.com/archives/CJJHJCJSJ/p1568645417013000?thread_ts=1568640504.009400&cid=CJJHJCJSJ
   */
  protected _latestValidBoardsConfig:
    | RecursiveRequired<BoardsConfig.Config>
    | undefined = undefined;
  protected _latestBoardsConfig: BoardsConfig.Config | undefined = undefined;
  protected _boardsConfig: BoardsConfig.Config = {};
  protected _attachedBoards: Board[] = []; // This does not contain the `Unknown` boards. They're visible from the available ports only.
  protected _availablePorts: Port[] = [];
  protected _availableBoards: AvailableBoard[] = [];

  /**
   * Unlike `onAttachedBoardsChanged` this even fires when the user modifies the selected board in the IDE.\
   * This even also fires, when the boards package was not available for the currently selected board,
   * and the user installs the board package. Note: installing a board package will set the `fqbn` of the
   * currently selected board.\
   * This event is also emitted when the board package for the currently selected board was uninstalled.
   */
  readonly onBoardsConfigChanged = this.onBoardsConfigChangedEmitter.event;
  readonly onAvailableBoardsChanged =
    this.onAvailableBoardsChangedEmitter.event;
  readonly onAvailablePortsChanged = this.onAvailablePortsChangedEmitter.event;

  private readonly _reconciled = new Deferred<void>();

  onStart(): void {
    this.notificationCenter.onAttachedBoardsDidChange(
      this.notifyAttachedBoardsChanged.bind(this)
    );
    this.notificationCenter.onPlatformDidInstall(
      this.notifyPlatformInstalled.bind(this)
    );
    this.notificationCenter.onPlatformDidUninstall(
      this.notifyPlatformUninstalled.bind(this)
    );

    this.appStateService.reachedState('ready').then(async () => {
      const [attachedBoards, availablePorts] = await Promise.all([
        this.boardsService.getAttachedBoards(),
        this.boardsService.getAvailablePorts(),
        this.loadState(),
      ]);
      this._attachedBoards = attachedBoards;
      this._availablePorts = availablePorts;
      this.onAvailablePortsChangedEmitter.fire(this._availablePorts);

      await this.reconcileAvailableBoards();

      this.tryReconnect();
      this._reconciled.resolve();
    });
  }

  get reconciled(): Promise<void> {
    return this._reconciled.promise;
  }

  protected notifyAttachedBoardsChanged(
    event: AttachedBoardsChangeEvent
  ): void {
    if (!AttachedBoardsChangeEvent.isEmpty(event)) {
      this.logger.info('Attached boards and available ports changed:');
      this.logger.info(AttachedBoardsChangeEvent.toString(event));
      this.logger.info('------------------------------------------');
    }
    this._attachedBoards = event.newState.boards;
    this._availablePorts = event.newState.ports;
    this.onAvailablePortsChangedEmitter.fire(this._availablePorts);
    this.reconcileAvailableBoards().then(() => this.tryReconnect());
  }

  protected notifyPlatformInstalled(event: { item: BoardsPackage }): void {
    this.logger.info('Boards package installed: ', JSON.stringify(event));
    const { selectedBoard } = this.boardsConfig;
    const { installedVersion, id } = event.item;
    if (selectedBoard) {
      const installedBoard = event.item.boards.find(
        ({ name }) => name === selectedBoard.name
      );
      if (
        installedBoard &&
        (!selectedBoard.fqbn || selectedBoard.fqbn === installedBoard.fqbn)
      ) {
        this.logger.info(
          `Board package ${id}[${installedVersion}] was installed. Updating the FQBN of the currently selected ${selectedBoard.name} board. [FQBN: ${installedBoard.fqbn}]`
        );
        this.boardsConfig = {
          ...this.boardsConfig,
          selectedBoard: installedBoard,
        };
        return;
      }
      // The board name can change after install.
      // This logic handles it "gracefully" by unselecting the board, so that we can avoid no FQBN is set error.
      // https://github.com/arduino/arduino-cli/issues/620
      // https://github.com/arduino/arduino-pro-ide/issues/374
      if (
        BoardWithPackage.is(selectedBoard) &&
        selectedBoard.packageId === event.item.id &&
        !installedBoard
      ) {
        const yes = nls.localize('vscode/extensionsUtils/yes', 'Yes');
        this.messageService
          .warn(
            nls.localize(
              'arduino/board/couldNotFindPreviouslySelected',
              "Could not find previously selected board '{0}' in installed platform '{1}'. Please manually reselect the board you want to use. Do you want to reselect it now?",
              selectedBoard.name,
              event.item.name
            ),
            nls.localize('arduino/board/reselectLater', 'Reselect later'),
            yes
          )
          .then(async (answer) => {
            if (answer === yes) {
              this.commandService.executeCommand(
                'arduino-open-boards-dialog',
                selectedBoard.name
              );
            }
          });
        this.boardsConfig = {};
        return;
      }
      // Trigger a board re-set. See: https://github.com/arduino/arduino-cli/issues/954
      // E.g: install `adafruit:avr`, then select `adafruit:avr:adafruit32u4` board, and finally install the required `arduino:avr`
      this.boardsConfig = this.boardsConfig;
    }
  }

  protected notifyPlatformUninstalled(event: { item: BoardsPackage }): void {
    this.logger.info('Boards package uninstalled: ', JSON.stringify(event));
    const { selectedBoard } = this.boardsConfig;
    if (selectedBoard && selectedBoard.fqbn) {
      const uninstalledBoard = event.item.boards.find(
        ({ name }) => name === selectedBoard.name
      );
      if (uninstalledBoard && uninstalledBoard.fqbn === selectedBoard.fqbn) {
        // We should not unset the FQBN, if the selected board is an attached, recognized board.
        // Attach Uno and install AVR, select Uno. Uninstall the AVR core while Uno is selected. We do not want to discard the FQBN of the Uno board.
        // Dev note: We cannot assume the `selectedBoard` is a type of `AvailableBoard`.
        // When the user selects an `AvailableBoard` it works, but between app start/stops,
        // it is just a FQBN, so we need to find the `selected` board among the `AvailableBoards`
        const selectedAvailableBoard = AvailableBoard.is(selectedBoard)
          ? selectedBoard
          : this._availableBoards.find((availableBoard) =>
              Board.sameAs(availableBoard, selectedBoard)
            );
        if (
          selectedAvailableBoard &&
          selectedAvailableBoard.selected &&
          selectedAvailableBoard.state === AvailableBoard.State.recognized
        ) {
          return;
        }
        this.logger.info(
          `Board package ${event.item.id} was uninstalled. Discarding the FQBN of the currently selected ${selectedBoard.name} board.`
        );
        const selectedBoardWithoutFqbn = {
          name: selectedBoard.name,
          // No FQBN
        };
        this.boardsConfig = {
          ...this.boardsConfig,
          selectedBoard: selectedBoardWithoutFqbn,
        };
      }
    }
  }

  protected tryReconnect(): boolean {
    if (this._latestValidBoardsConfig && !this.canUploadTo(this.boardsConfig)) {
      for (const board of this.availableBoards.filter(
        ({ state }) => state !== AvailableBoard.State.incomplete
      )) {
        if (
          this._latestValidBoardsConfig.selectedBoard.fqbn === board.fqbn &&
          this._latestValidBoardsConfig.selectedBoard.name === board.name &&
          Port.sameAs(this._latestValidBoardsConfig.selectedPort, board.port)
        ) {
          this.boardsConfig = this._latestValidBoardsConfig;
          return true;
        }
      }
      // If we could not find an exact match, we compare the board FQBN-name pairs and ignore the port, as it might have changed.
      // See documentation on `latestValidBoardsConfig`.
      for (const board of this.availableBoards.filter(
        ({ state }) => state !== AvailableBoard.State.incomplete
      )) {
        if (
          this._latestValidBoardsConfig.selectedBoard.fqbn === board.fqbn &&
          this._latestValidBoardsConfig.selectedBoard.name === board.name &&
          this._latestValidBoardsConfig.selectedPort.protocol ===
            board.port?.protocol
        ) {
          this.boardsConfig = {
            ...this._latestValidBoardsConfig,
            selectedPort: board.port,
          };
          return true;
        }
      }
    }
    return false;
  }

  set boardsConfig(config: BoardsConfig.Config) {
    this.setBoardsConfig(config);
    this.saveState().finally(() =>
      this.reconcileAvailableBoards().finally(() =>
        this.onBoardsConfigChangedEmitter.fire(this._boardsConfig)
      )
    );
  }

  get boardsConfig(): BoardsConfig.Config {
    return this._boardsConfig;
  }

  get latestValidBoardsConfig():
    | RecursiveRequired<BoardsConfig.Config>
    | undefined {
    return this._latestValidBoardsConfig;
  }

  get latestBoardsConfig(): BoardsConfig.Config | undefined {
    return this._latestBoardsConfig;
  }

  protected setBoardsConfig(config: BoardsConfig.Config): void {
    this.logger.debug('Board config changed: ', JSON.stringify(config));
    this._boardsConfig = config;
    this._latestBoardsConfig = this._boardsConfig;
    if (this.canUploadTo(this._boardsConfig)) {
      this._latestValidBoardsConfig = this._boardsConfig;
    }
  }

  async searchBoards({
    query,
    cores,
  }: {
    query?: string;
    cores?: string[];
  }): Promise<BoardWithPackage[]> {
    const boards = await this.boardsService.searchBoards({ query });
    return boards;
  }

  async selectedBoardUserFields(): Promise<BoardUserField[]> {
    if (!this._boardsConfig.selectedBoard || !this._boardsConfig.selectedPort) {
      return [];
    }
    const fqbn = this._boardsConfig.selectedBoard.fqbn;
    if (!fqbn) {
      return [];
    }
    const protocol = this._boardsConfig.selectedPort.protocol;
    return await this.boardsService.getBoardUserFields({ fqbn, protocol });
  }

  /**
   * `true` if the `config.selectedBoard` is defined; hence can compile against the board. Otherwise, `false`.
   */
  canVerify(
    config: BoardsConfig.Config | undefined = this.boardsConfig,
    options: { silent: boolean } = { silent: true }
  ): config is BoardsConfig.Config & { selectedBoard: Board } {
    if (!config) {
      return false;
    }

    if (!config.selectedBoard) {
      if (!options.silent) {
        this.messageService.warn(
          nls.localize('arduino/board/noneSelected', 'No boards selected.'),
          {
            timeout: 3000,
          }
        );
      }
      return false;
    }

    return true;
  }

  /**
   * `true` if `canVerify`, the board has an FQBN and the `config.selectedPort` is also set, hence can upload to board. Otherwise, `false`.
   */
  canUploadTo(
    config: BoardsConfig.Config | undefined = this.boardsConfig,
    options: { silent: boolean } = { silent: true }
  ): config is RecursiveRequired<BoardsConfig.Config> {
    if (!this.canVerify(config, options)) {
      return false;
    }

    const { name } = config.selectedBoard;
    if (!config.selectedPort) {
      if (!options.silent) {
        this.messageService.warn(
          nls.localize(
            'arduino/board/noPortsSelected',
            "No ports selected for board: '{0}'.",
            name
          ),
          {
            timeout: 3000,
          }
        );
      }
      return false;
    }

    if (!config.selectedBoard.fqbn) {
      if (!options.silent) {
        this.messageService.warn(
          nls.localize(
            'arduino/board/noFQBN',
            'The FQBN is not available for the selected board "{0}". Do you have the corresponding core installed?',
            name
          ),
          { timeout: 3000 }
        );
      }
      return false;
    }

    return true;
  }

  get availableBoards(): AvailableBoard[] {
    return this._availableBoards;
  }

  async waitUntilAvailable(
    what: Board & { port: Port },
    timeout?: number
  ): Promise<void> {
    const find = (needle: Board & { port: Port }, haystack: AvailableBoard[]) =>
      haystack.find(
        (board) =>
          Board.equals(needle, board) && Port.sameAs(needle.port, board.port)
      );
    const timeoutTask =
      !!timeout && timeout > 0
        ? new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout after ${timeout} ms.`)),
              timeout
            )
          )
        : new Promise<void>(() => {
            /* never */
          });
    const waitUntilTask = new Promise<void>((resolve) => {
      let candidate = find(what, this.availableBoards);
      if (candidate) {
        resolve();
        return;
      }
      const disposable = this.onAvailableBoardsChanged((availableBoards) => {
        candidate = find(what, availableBoards);
        if (candidate) {
          disposable.dispose();
          resolve();
        }
      });
    });
    return await Promise.race([waitUntilTask, timeoutTask]);
  }

  protected async reconcileAvailableBoards(): Promise<void> {
    const availablePorts = this._availablePorts;
    // Unset the port on the user's config, if it is not available anymore.
    if (
      this.boardsConfig.selectedPort &&
      !availablePorts.some((port) =>
        Port.sameAs(port, this.boardsConfig.selectedPort)
      )
    ) {
      this.setBoardsConfig({
        selectedBoard: this.boardsConfig.selectedBoard,
        selectedPort: undefined,
      });
      this.onBoardsConfigChangedEmitter.fire(this._boardsConfig);
    }
    const boardsConfig = this.boardsConfig;
    const currentAvailableBoards = this._availableBoards;
    const availableBoards: AvailableBoard[] = [];
    const attachedBoards = this._attachedBoards.filter(({ port }) => !!port);
    const availableBoardPorts = availablePorts.filter((port) => {
      if (port.protocol === 'serial') {
        // We always show all serial ports, even if there
        // is no recognized board connected to it
        return true;
      }

      // All other ports with different protocol are
      // only shown if there is a recognized board
      // connected
      for (const board of attachedBoards) {
        if (board.port?.address === port.address) {
          return true;
        }
      }
      return false;
    });

    for (const boardPort of availableBoardPorts) {
      const board = attachedBoards.find(({ port }) =>
        Port.sameAs(boardPort, port)
      );
      const lastSelectedBoard = await this.getLastSelectedBoardOnPort(
        boardPort
      );

      let availableBoard = {} as AvailableBoard;
      if (board) {
        availableBoard = {
          ...board,
          state: AvailableBoard.State.recognized,
          selected: BoardsConfig.Config.sameAs(boardsConfig, board),
          port: boardPort,
        };
      } else if (lastSelectedBoard) {
        // If the selected board is not recognized because it is a 3rd party board: https://github.com/arduino/arduino-cli/issues/623
        // We still want to show it without the red X in the boards toolbar: https://github.com/arduino/arduino-pro-ide/issues/198#issuecomment-599355836
        availableBoard = {
          ...lastSelectedBoard,
          state: AvailableBoard.State.guessed,
          selected: BoardsConfig.Config.sameAs(boardsConfig, lastSelectedBoard),
          port: boardPort,
        };
      } else {
        availableBoard = {
          name: nls.localize('arduino/common/unknown', 'Unknown'),
          port: boardPort,
          state: AvailableBoard.State.incomplete,
        };
      }
      availableBoards.push(availableBoard);
    }

    if (
      boardsConfig.selectedBoard &&
      !availableBoards.some(({ selected }) => selected)
    ) {
      // If the selected board has the same port of an unknown board
      // that is already in availableBoards we might get a duplicate port.
      // So we remove the one already in the array and add the selected one.
      const found = availableBoards.findIndex(
        (board) => board.port?.address === boardsConfig.selectedPort?.address
      );
      if (found >= 0) {
        availableBoards.splice(found, 1);
      }
      availableBoards.push({
        ...boardsConfig.selectedBoard,
        port: boardsConfig.selectedPort,
        selected: true,
        state: AvailableBoard.State.incomplete,
      });
    }

    availableBoards.sort(AvailableBoard.compare);

    let hasChanged = availableBoards.length !== currentAvailableBoards.length;
    for (let i = 0; !hasChanged && i < availableBoards.length; i++) {
      const [left, right] = [availableBoards[i], currentAvailableBoards[i]];
      hasChanged =
        left.fqbn !== right.fqbn ||
        !!AvailableBoard.compare(left, right) ||
        left.selected !== right.selected;
    }
    if (hasChanged) {
      this._availableBoards = availableBoards;
      this.onAvailableBoardsChangedEmitter.fire(this._availableBoards);
    }
  }

  protected async getLastSelectedBoardOnPort(
    port: Port
  ): Promise<Board | undefined> {
    const key = getLastSelectedBoardOnPortKey(port);
    return this.getData<Board>(key);
  }

  protected async saveState(): Promise<void> {
    // We save the port with the selected board name/FQBN, to be able to guess a better board name.
    // Required when the attached board belongs to a 3rd party boards package, and neither the name, nor
    // the FQBN can be retrieved with a `board list` command.
    // https://github.com/arduino/arduino-cli/issues/623
    const { selectedBoard, selectedPort } = this.boardsConfig;
    if (selectedBoard && selectedPort) {
      const key = getLastSelectedBoardOnPortKey(selectedPort);
      await this.setData(key, selectedBoard);
    }
    await Promise.all([
      this.setData(LATEST_VALID_BOARDS_CONFIG, this._latestValidBoardsConfig),
      this.setData(LATEST_BOARDS_CONFIG, this._latestBoardsConfig),
    ]);
  }

  protected async loadState(): Promise<void> {
    const storedLatestValidBoardsConfig = await this.getData<
      RecursiveRequired<BoardsConfig.Config>
    >(LATEST_VALID_BOARDS_CONFIG);
    if (storedLatestValidBoardsConfig) {
      this._latestValidBoardsConfig = storedLatestValidBoardsConfig;
      if (this.canUploadTo(this._latestValidBoardsConfig)) {
        this.boardsConfig = this._latestValidBoardsConfig;
      }
    } else {
      // If we could not restore the latest valid config, try to restore something, the board at least.
      let storedLatestBoardsConfig = await this.getData<
        BoardsConfig.Config | undefined
      >(LATEST_BOARDS_CONFIG);
      // Try to get from the URL if it was not persisted.
      if (!storedLatestBoardsConfig) {
        storedLatestBoardsConfig = BoardsConfig.Config.getConfig(
          new URL(window.location.href)
        );
      }
      if (storedLatestBoardsConfig) {
        this._latestBoardsConfig = storedLatestBoardsConfig;
        this.boardsConfig = this._latestBoardsConfig;
      }
    }
  }

  private setData<T>(key: string, value: T): Promise<void> {
    return this.commandService.executeCommand(
      StorageWrapper.Commands.SET_DATA.id,
      key,
      value
    );
  }

  private getData<T>(key: string): Promise<T | undefined> {
    return this.commandService.executeCommand<T>(
      StorageWrapper.Commands.GET_DATA.id,
      key
    );
  }
}

/**
 * Representation of a ready-to-use board, either the user has configured it or was automatically recognized by the CLI.
 * An available board was not necessarily recognized by the CLI (e.g.: it is a 3rd party board) or correctly configured but ready for `verify`.
 * If it has the selected board and a associated port, it can be used for `upload`. We render an available board for the user
 * when it has the `port` set.
 */
export interface AvailableBoard extends Board {
  readonly state: AvailableBoard.State;
  readonly selected?: boolean;
  readonly port?: Port;
}

export namespace AvailableBoard {
  export enum State {
    /**
     * Retrieved from the CLI via the `board list` command.
     */
    'recognized',
    /**
     * Guessed the name/FQBN of the board from the available board ports (3rd party).
     */
    'guessed',
    /**
     * We do not know anything about this board, probably a 3rd party. The user has not selected a board for this port yet.
     */
    'incomplete',
  }

  export function is(board: any): board is AvailableBoard {
    return Board.is(board) && 'state' in board;
  }

  export function hasPort(
    board: AvailableBoard
  ): board is AvailableBoard & { port: Port } {
    return !!board.port;
  }

  // Available boards must be sorted in this order:
  // 1. Serial with recognized boards
  // 2. Serial with guessed boards
  // 3. Serial with incomplete boards
  // 4. Network with recognized boards
  // 5. Other protocols with recognized boards
  export const compare = (left: AvailableBoard, right: AvailableBoard) => {
    if (left.port?.protocol === 'serial' && right.port?.protocol !== 'serial') {
      return -1;
    } else if (
      left.port?.protocol !== 'serial' &&
      right.port?.protocol === 'serial'
    ) {
      return 1;
    } else if (
      left.port?.protocol === 'network' &&
      right.port?.protocol !== 'network'
    ) {
      return -1;
    } else if (
      left.port?.protocol !== 'network' &&
      right.port?.protocol === 'network'
    ) {
      return 1;
    } else if (left.port?.protocol === right.port?.protocol) {
      // We show all ports, including those that have guessed
      // or unrecognized boards, so we must sort those too.
      if (left.state < right.state) {
        return -1;
      } else if (left.state > right.state) {
        return 1;
      }
    }
    return naturalCompare(left.port?.address!, right.port?.address!);
  };
}

export function getLastSelectedBoardOnPortKey(port: Port | string): string {
  // TODO: we lose the port's `protocol` info (`serial`, `network`, etc.) here if the `port` is a `string`.
  return `last-selected-board-on-port:${
    typeof port === 'string' ? port : port.address
  }`;
}
