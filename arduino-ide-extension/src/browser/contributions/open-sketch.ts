import * as remote from '@theia/core/electron-shared/@electron/remote';
import { nls } from '@theia/core/lib/common/nls';
import { injectable } from '@theia/core/shared/inversify';
import { SketchesError, SketchRef } from '../../common/protocol';
import { ArduinoMenus } from '../menu/arduino-menus';
import {
  Command,
  CommandRegistry,
  KeybindingRegistry,
  MenuModelRegistry,
  Sketch,
  SketchContribution,
  URI,
} from './contribution';

export type SketchLocation = string | URI | SketchRef;
export namespace SketchLocation {
  export function toUri(location: SketchLocation): URI {
    if (typeof location === 'string') {
      return new URI(location);
    } else if (SketchRef.is(location)) {
      return toUri(location.uri);
    } else {
      return location;
    }
  }
  export function is(arg: unknown): arg is SketchLocation {
    return typeof arg === 'string' || arg instanceof URI || SketchRef.is(arg);
  }
}

@injectable()
export class OpenSketch extends SketchContribution {
  override registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(OpenSketch.Commands.OPEN_SKETCH, {
      execute: async (arg) => {
        const toOpen = !SketchLocation.is(arg)
          ? await this.selectSketch()
          : arg;
        if (toOpen) {
          return this.openSketch(toOpen);
        }
      },
    });
  }

  override registerMenus(registry: MenuModelRegistry): void {
    registry.registerMenuAction(ArduinoMenus.FILE__SKETCH_GROUP, {
      commandId: OpenSketch.Commands.OPEN_SKETCH.id,
      label: nls.localize('vscode/workspaceActions/openFileFolder', 'Open...'),
      order: '1',
    });
  }

  override registerKeybindings(registry: KeybindingRegistry): void {
    registry.registerKeybinding({
      command: OpenSketch.Commands.OPEN_SKETCH.id,
      keybinding: 'CtrlCmd+O',
    });
  }

  private async openSketch(toOpen: SketchLocation | undefined): Promise<void> {
    if (!toOpen) {
      return;
    }
    const uri = SketchLocation.toUri(toOpen);
    try {
      await this.sketchService.loadSketch(uri.toString());
    } catch (err) {
      if (SketchesError.NotFound.is(err)) {
        this.messageService.error(err.message);
      }
      throw err;
    }
    this.workspaceService.open(uri);
  }

  private async selectSketch(): Promise<Sketch | undefined> {
    const config = await this.configService.getConfiguration();
    const defaultPath = await this.fileService.fsPath(
      new URI(config.sketchDirUri)
    );
    const { filePaths } = await remote.dialog.showOpenDialog({
      defaultPath,
      properties: ['createDirectory', 'openFile'],
      filters: [
        {
          name: nls.localize('arduino/sketch/sketch', 'Sketch'),
          extensions: ['ino', 'pde'],
        },
      ],
    });
    if (!filePaths.length) {
      return undefined;
    }
    if (filePaths.length > 1) {
      this.logger.warn(
        `Multiple sketches were selected: ${filePaths}. Using the first one.`
      );
    }
    const sketchFilePath = filePaths[0];
    const sketchFileUri = await this.fileSystemExt.getUri(sketchFilePath);
    const sketch = await this.sketchService.getSketchFolder(sketchFileUri);
    if (sketch) {
      return sketch;
    }
    if (Sketch.isSketchFile(sketchFileUri)) {
      const name = new URI(sketchFileUri).path.name;
      const nameWithExt = this.labelProvider.getName(new URI(sketchFileUri));
      const { response } = await remote.dialog.showMessageBox({
        title: nls.localize('arduino/sketch/moving', 'Moving'),
        type: 'question',
        buttons: [
          nls.localize('vscode/issueMainService/cancel', 'Cancel'),
          nls.localize('vscode/issueMainService/ok', 'OK'),
        ],
        message: nls.localize(
          'arduino/sketch/movingMsg',
          'The file "{0}" needs to be inside a sketch folder named "{1}".\nCreate this folder, move the file, and continue?',
          nameWithExt,
          name
        ),
      });
      if (response === 1) {
        // OK
        const newSketchUri = new URI(sketchFileUri).parent.resolve(name);
        const exists = await this.fileService.exists(newSketchUri);
        if (exists) {
          await remote.dialog.showMessageBox({
            type: 'error',
            title: nls.localize('vscode/dialog/dialogErrorMessage', 'Error'),
            message: nls.localize(
              'arduino/sketch/cantOpen',
              'A folder named "{0}" already exists. Can\'t open sketch.',
              name
            ),
          });
          return undefined;
        }
        await this.fileService.createFolder(newSketchUri);
        await this.fileService.move(
          new URI(sketchFileUri),
          new URI(newSketchUri.resolve(nameWithExt).toString())
        );
        return this.sketchService.getSketchFolder(newSketchUri.toString());
      }
    }
  }
}

export namespace OpenSketch {
  export namespace Commands {
    export const OPEN_SKETCH: Command = {
      id: 'arduino-open-sketch',
    };
  }
}
