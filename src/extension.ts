
/*
 * ============================================================
 * FORMATFLIP — VS CODE EXTENSION
 * ============================================================
 *
 * WHAT THIS FILE DOES
 *
 * This file contains the main logic for FormatFlip:
 *
 * 1. Opens a drag-and-drop image conversion panel.
 * 2. Converts selected images from VS Code Explorer.
 * 3. Reads images from the Windows clipboard.
 * 4. Copies an image's path to the clipboard.
 * 5. Converts supported images to WebP using Sharp.
 * 6. Avoids overwriting existing files.
 * 7. Checks that output folders stay inside the workspace.
 * 8. Reports conversion results and file-size savings.
 *
 * IMPORTANT CONCEPT:
 *
 * VS Code calls activate() when it activates this extension.
 * activate() registers commands using registerCommand().
 * Each command connects a command ID to a function.
 *
 * Example:
 * 'formatflip.openDropPanel' -> openDropPanel()
 *
 * package.json declares the commands that users can discover.
 * This file implements what those commands actually do.
 */

// vscode provides the VS Code extension API: commands,
// windows, workspaces, webviews, notifications, and more.
import * as vscode from 'vscode';

// path provides safe file-path operations.
// For example: joining folders and extracting file extensions.
import * as path from 'node:path';

// fs/promises provides asynchronous file operations:
// reading files, writing files, checking folders, and so on.
import * as fs from 'node:fs/promises';

// execFile lets us run an external program.
// FormatFlip uses Windows PowerShell to read the clipboard.
import { execFile } from 'node:child_process';

// promisify converts callback-based functions into functions
// that work with async/await and return Promises.
import { promisify } from 'node:util';

// Sharp is the image-processing library that converts images
// into WebP format.
import sharp from 'sharp';

// We create an async version of execFile so that we can write:
//
// const result = await execFileAsync(...);
//
// instead of using a callback.
const execFileAsync = promisify(execFile);


// ============================================================
// 1. CONSTANTS AND TYPES
// ============================================================

// Set contains unique values.
// We use it to recognise supported image file extensions.
//
// toLowerCase() is used later, so IMAGE.PNG and image.png
// are treated the same way.
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.tif',
  '.tiff',
]);

// When scanning a folder recursively, we skip these folders.
//
// For example, we don't want to search thousands of files
// inside node_modules or accidentally process build output.
const SKIP_FOLDERS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
]);

// A TypeScript type describes the structure of an object.
//
// SourceFile describes a source image.
// PanelFile describes an image sent by the webview.
//
// These types help TypeScript catch mistakes while coding.
type SourceFile = {
  path: string;
  name: string;
};

type PanelFile = {
  name: string;
  base64: string;
};


// ============================================================
// 2. EXTENSION ACTIVATION AND COMMAND REGISTRATION
// ============================================================

/*
 * VS Code calls activate() when this extension activates.
 *
 * context contains information about the extension's lifetime.
 * context.subscriptions stores disposable resources so that
 * VS Code can clean them up when the extension is deactivated.
 *
 * registerCommand(commandId, callback):
 *
 * - commandId identifies the command.
 * - callback is the function that runs when it is invoked.
 *
 * These IDs must match the corresponding command IDs in
 * package.json.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(

    // Command 1:
    // Opens FormatFlip's drag-and-drop webview.
    vscode.commands.registerCommand(
      'formatflip.openDropPanel',
      () => openDropPanel(context),
    ),

    // Command 2:
    // Converts images or folders selected in Explorer.
    //
    // VS Code passes information about the selected items
    // into the command callback.
    vscode.commands.registerCommand(
      'formatflip.convertSelectedImages',
      (...args: unknown[]) => convertExplorerSelection(context, args),
    ),

    // Command 3:
    // Reads an image or image file from the Windows clipboard.
    vscode.commands.registerCommand(
      'formatflip.saveClipboardImage',
      () => saveClipboardImage(context),
    ),

    // Command 4:
    // Copies the selected image's path to the clipboard.
    vscode.commands.registerCommand(
      'formatflip.copyImagePath',
      (uri?: vscode.Uri) => copyImagePath(uri),
    ),
  );
}

/*
 * deactivate() is called when VS Code deactivates the extension.
 *
 * We don't currently need any extra cleanup here, so the
 * function is empty.
 */
export function deactivate(): void {}


// ============================================================
// 3. WORKSPACE AND FILE-PATH HELPERS
// ============================================================

/*
 * The workspace is the project folder opened in VS Code.
 *
 * Example:
 * D:\MyProject
 *
 * workspaceFolders can be undefined if no folder is open.
 * The question mark ?. safely handles that situation.
 */
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/*
 * Checks whether a file path has a supported image extension.
 *
 * path.extname('photo.PNG') returns '.PNG'.
 * We convert it to lowercase before checking the Set.
 *
 * Note: an extension alone does not prove that a file
 * contains a valid image. Sharp checks the actual image data
 * during conversion.
 */
function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/*
 * Checks whether child is inside parent.
 *
 * Example:
 * parent = D:\Project
 * child  = D:\Project\public\images
 *
 * Result: true
 *
 * But:
 * child = D:\OtherProject\images
 *
 * Result: false
 *
 * path.relative() is used instead of a simple startsWith()
 * check, because a path such as D:\ProjectBackup should not
 * count as being inside D:\Project.
 */
function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);

  return relative === '' ||
    (
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative)
    );
}

/*
 * Converts a user-entered name into a safer WebP filename.
 *
 * Example:
 * "My Summer Photo.png" -> "My-Summer-Photo.webp"
 *
 * It:
 * - Removes directory components.
 * - Removes an existing .webp suffix.
 * - Replaces Windows-invalid filename characters.
 * - Removes trailing dots and spaces.
 * - Replaces spaces with hyphens.
 * - Supplies a fallback name if the input is empty.
 * - Avoids reserved Windows device names such as CON.
 *
 * The function returns a filename, not a full path.
 */
function sanitizeFilename(value: string): string {
  // Keep only the final path component.
  let name = path.basename(value.trim());

  // Remove .webp so that we don't create photo.webp.webp.
  name = name.replace(/\.webp$/i, '');

  // Windows doesn't allow these characters in filenames.
  name = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();

  // Make filenames easier to use in code and URLs.
  name = name.replace(/\s+/g, '-').replace(/-+/g, '-');

  // Prevent empty or invalid basic names.
  if (!name || name === '.' || name === '..') {
    name = 'image';
  }

  // Windows reserves these names for special devices.
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    name = `_${name}`;
  }

  return `${name}.webp`;
}

/*
 * Converts a byte count into a readable size.
 *
 * Example:
 * 2048 -> "2.0 KB"
 *
 * One KB is treated as 1024 bytes.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];

  let value = bytes / 1024;
  let index = 0;

  // Move from KB to MB, then GB, when necessary.
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }

  return `${value.toFixed(1)} ${units[index]}`;
}

/*
 * Compares original and converted file sizes.
 *
 * A WebP file isn't guaranteed to be smaller than every
 * possible source image. If the result is larger, we report
 * that honestly instead of claiming a saving.
 */
function formatSavings(original: number, converted: number): string {
  if (original <= 0) {
    return 'size comparison unavailable';
  }

  const difference = original - converted;
  const percentage = (difference / original) * 100;

  if (difference >= 0) {
    return `${formatBytes(difference)} saved (${percentage.toFixed(1)}% smaller)`;
  }

  return `${formatBytes(Math.abs(difference))} larger (${Math.abs(percentage).toFixed(1)}% larger)`;
}


// ============================================================
// 4. CHOOSING AND VALIDATING OUTPUT FOLDERS
// ============================================================

/*
 * Gets the default output folder from VS Code settings.
 *
 * package.json defines the setting:
 * formatflip.outputDirectory
 *
 * Its default value is public/images.
 *
 * path.resolve() creates an absolute path based on the project.
 *
 * If createIfMissing is true, mkdir() creates the folder
 * and any missing parent folders.
 */
async function getDefaultOutputFolder(
  createIfMissing = false,
): Promise<string> {
  const root = workspaceRoot();

  if (!root) {
    throw new Error('Open a project folder in VS Code first.');
  }

  const configured = vscode.workspace
    .getConfiguration('formatflip')
    .get<string>('outputDirectory', 'public/images');

  const destination = path.resolve(
    root,
    configured || 'public/images',
  );

  // Reject configured paths that escape the workspace.
  if (!isPathInside(path.resolve(root), destination)) {
    throw new Error(
      'The configured output folder must stay inside your workspace.',
    );
  }

  // recursive: true creates parent folders if necessary.
  if (createIfMissing) {
    await fs.mkdir(destination, { recursive: true });
  }

  return destination;
}

/*
 * Validates a destination folder before saving files.
 *
 * There are two levels of checking:
 *
 * 1. Resolve the path and ensure it is inside the workspace.
 * 2. Resolve real filesystem paths using realpath().
 *
 * The second check helps detect symbolic links that point
 * outside the workspace.
 *
 * The function also confirms that the destination exists
 * and is a directory.
 */
async function validateOutputFolder(
  folderPath: string,
  createIfMissing = false,
): Promise<string> {
  const root = workspaceRoot();

  if (!root) {
    throw new Error('Open a project folder in VS Code first.');
  }

  const absoluteRoot = path.resolve(root);
  const absoluteFolder = path.resolve(folderPath);

  if (!isPathInside(absoluteRoot, absoluteFolder)) {
    throw new Error(
      'FormatFlip can only save images inside the open workspace.',
    );
  }

  if (createIfMissing) {
    await fs.mkdir(absoluteFolder, { recursive: true });
  }

  // realpath() resolves filesystem references to their actual
  // locations, including existing symbolic links.
  const rootReal = await fs.realpath(absoluteRoot);
  const folderReal = await fs.realpath(absoluteFolder);

  if (!isPathInside(rootReal, folderReal)) {
    throw new Error(
      'The selected folder resolves outside the workspace. Choose a folder inside your project.',
    );
  }

  // stat() gives information about the filesystem object.
  const stat = await fs.stat(folderReal);

  if (!stat.isDirectory()) {
    throw new Error('The selected destination is not a folder.');
  }

  // Return the validated absolute filesystem path.
  return folderReal;
}

/*
 * Asks the user where converted images should be saved.
 *
 * First, a Quick Pick presents two choices:
 * - Use the configured default folder.
 * - Choose another folder.
 *
 * If the user chooses a custom folder, VS Code opens its
 * folder-selection dialog.
 *
 * Cancelling either dialog returns undefined.
 */
async function chooseOutputFolder(): Promise<string | undefined> {
  const root = workspaceRoot();

  if (!root) {
    void vscode.window.showErrorMessage(
      'FormatFlip: Open a project folder in VS Code first.',
    );

    return undefined;
  }

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'Use default folder',
        description: vscode.workspace
          .getConfiguration('formatflip')
          .get<string>('outputDirectory', 'public/images'),
        value: 'default',
      },
      {
        label: 'Choose a different folder…',
        description: 'Pick another folder inside this workspace',
        value: 'custom',
      },
    ],
    {
      placeHolder: 'Where should FormatFlip save the WebP images?',
    },
  );

  // The user dismissed the menu.
  if (!choice) {
    return undefined;
  }

  if (choice.value === 'default') {
    return validateOutputFolder(
      await getDefaultOutputFolder(true),
      true,
    );
  }

  // Ask VS Code to display a folder picker.
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use this folder',
    defaultUri: vscode.Uri.file(root),
    title: 'Choose a destination folder inside your workspace',
  });

  if (!picked?.[0]) {
    return undefined;
  }

  return validateOutputFolder(picked[0].fsPath);
}


// ============================================================
// 5. DUPLICATE FILENAMES AND WEBP CONVERSION
// ============================================================

/*
 * Finds an unused output filename.
 *
 * Example:
 * photo.webp already exists.
 *
 * The next filename becomes:
 * photo-2.webp
 *
 * If that also exists:
 * photo-3.webp
 *
 * fs.access() checks whether a path can be accessed.
 * If it succeeds, the filename is already taken.
 * If it throws, we treat the candidate as available.
 */
async function uniqueDestination(
  folder: string,
  requestedName: string,
): Promise<string> {
  const safeName = sanitizeFilename(requestedName);
  const parsed = path.parse(safeName);

  let candidate = path.join(folder, safeName);
  let suffix = 2;

  while (true) {
    try {
      await fs.access(candidate);

      // The name exists, so try the next numbered version.
      candidate = path.join(
        folder,
        `${parsed.name}-${suffix}${parsed.ext}`,
      );

      suffix++;
    } catch {
      // No existing file was found at this candidate.
      return candidate;
    }
  }
}

/*
 * THE CORE IMAGE-CONVERSION FUNCTION.
 *
 * Input:
 * - buffer: the image's raw bytes in memory.
 * - requestedName: the output filename the user wants.
 * - folder: the destination directory.
 *
 * Steps:
 * 1. Find an available filename.
 * 2. Read the configured WebP quality.
 * 3. Ask Sharp to decode the image and encode it as WebP.
 * 4. Write the new bytes to disk.
 * 5. Return the path and sizes for the success message.
 *
 * Buffer means binary data held in memory.
 *
 * sharp(buffer) accepts image bytes directly. Sharp detects
 * the image format from its contents, not just its filename.
 *
 * quality normally ranges from 1 to 100.
 *
 * toBuffer() means the converted image is held in memory
 * before we write it to the destination.
 */
async function convertBuffer(
  buffer: Buffer,
  requestedName: string,
  folder: string,
): Promise<{
  path: string;
  originalBytes: number;
  convertedBytes: number;
}> {
  const destination = await uniqueDestination(
    folder,
    requestedName,
  );

  const quality = vscode.workspace
    .getConfiguration('formatflip')
    .get<number>('quality', 82);

  const webp = await sharp(buffer, { failOn: 'error' })
    .webp({
      quality: Math.max(1, Math.min(100, quality)),
    })
    .toBuffer();

  // 'wx' asks Node.js to create a new file exclusively.
  // If the file already exists, writing fails rather than
  // silently overwriting it.
  await fs.writeFile(destination, webp, { flag: 'wx' });

  return {
    path: destination,
    originalBytes: buffer.length,
    convertedBytes: webp.length,
  };
}

/*
 * Convenience function for converting an image already
 * stored on disk.
 *
 * fs.readFile() loads the file into a Buffer.
 * We then reuse convertBuffer() rather than duplicating
 * the Sharp conversion logic.
 *
 * This is a useful design principle:
 * one central conversion function means fewer places
 * where conversion bugs can occur.
 */
async function convertPath(
  sourcePath: string,
  requestedName: string,
  folder: string,
): Promise<{
  path: string;
  originalBytes: number;
  convertedBytes: number;
}> {
  const buffer = await fs.readFile(sourcePath);

  return convertBuffer(buffer, requestedName, folder);
}


// ============================================================
// 6. CONVERTING IMAGES SELECTED IN VS CODE EXPLORER
// ============================================================

/*
 * This function runs when the user invokes:
 * formatflip.convertSelectedImages
 *
 * VS Code may pass one URI or multiple selected URIs.
 * A URI identifies a resource such as a file or folder.
 *
 * We inspect the arguments, collect supported image paths,
 * ask for output names, and start the conversion process.
 */
async function convertExplorerSelection(
  _context: vscode.ExtensionContext,
  args: unknown[],
): Promise<void> {
  try {
    const uris: vscode.Uri[] = [];

    // This helper extracts URI values from command arguments.
    // Some VS Code commands pass an array of selected items.
    const addValue = (value: unknown): void => {
      if (value instanceof vscode.Uri) {
        uris.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(addValue);
      }
    };

    args.forEach(addValue);

    if (uris.length === 0) {
      void vscode.window.showInformationMessage(
        'FormatFlip: Select one or more image files or a folder in Explorer first.',
      );

      return;
    }

    const paths: string[] = [];

    // Check each selected file or folder.
    for (const uri of uris) {
      // A deleted or inaccessible item should not crash the
      // entire operation, so a failed stat becomes undefined.
      const stat = await fs.stat(uri.fsPath).catch(() => undefined);

      if (!stat) {
        continue;
      }

      if (stat.isDirectory()) {
        // If the user selected a folder, scan it recursively.
        await collectImages(uri.fsPath, paths);
      } else if (stat.isFile() && isImagePath(uri.fsPath)) {
        paths.push(uri.fsPath);
      }
    }

    // Set removes duplicate path strings.
    const uniquePaths = [...new Set(paths)];

    if (uniquePaths.length === 0) {
      void vscode.window.showWarningMessage(
        'FormatFlip: No supported images were found in your selection.',
      );

      return;
    }

    // Ask for the output folder, then names, then convert.
    await promptNamesAndConvert(
      uniquePaths,
      await chooseOutputFolder(),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `FormatFlip: ${errorMessage(error)}`,
    );
  }
}

/*
 * Recursively scans a folder for supported images.
 *
 * Recursive means the function can call itself for a
 * subfolder, allowing it to search nested directories.
 *
 * Example:
 * public/
 *   images/
 *     logo.png
 *   gallery/
 *     summer/
 *       beach.jpg
 *
 * Both logo.png and beach.jpg can be discovered.
 *
 * We skip known dependency/build folders to avoid wasting
 * time scanning irrelevant files.
 */
async function collectImages(
  folder: string,
  output: string[],
): Promise<void> {
  const entries = await fs.readdir(folder, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_FOLDERS.has(entry.name)) {
        await collectImages(
          path.join(folder, entry.name),
          output,
        );
      }
    } else if (
      entry.isFile() &&
      isImagePath(entry.name)
    ) {
      output.push(path.join(folder, entry.name));
    }
  }
}


// ============================================================
// 7. ASKING FOR NAMES AND CONVERTING A BATCH OF FILES
// ============================================================

/*
 * This function handles multiple source images.
 *
 * First, it asks the user to name each output image.
 * Only after all names are entered does conversion begin.
 *
 * The same function is used by Explorer conversion and
 * clipboard image-file conversion.
 */
async function promptNamesAndConvert(
  paths: string[],
  destination: string | undefined,
): Promise<void> {
  // If the user cancelled the destination picker, stop.
  if (!destination) {
    return;
  }

  const named: Array<{
    source: string;
    name: string;
  }> = [];

  // Ask for a name for every source image.
  for (let index = 0; index < paths.length; index++) {
    const source = paths[index];
    const defaultName = path.parse(source).name;

    const entered = await vscode.window.showInputBox({
      title: `Rename image ${index + 1} of ${paths.length}`,
      prompt: 'Enter the filename for the converted WebP image (without needing to type .webp)',
      value: defaultName,

      // Returning an error message prevents an empty name.
      validateInput: (value) =>
        value.trim() ? undefined : 'Enter a filename.',
    });

    // undefined means the user cancelled the input box.
    if (entered === undefined) {
      void vscode.window.showInformationMessage(
        `FormatFlip: Conversion cancelled. ${named.length} image name(s) were prepared.`,
      );

      return;
    }

    named.push({
      source,
      name: entered,
    });
  }

  // Counters used to build the final report.
  let succeeded = 0;
  let failed = 0;
  let originalTotal = 0;
  let convertedTotal = 0;

  // Keep a record of individual errors for the warning.
  const errors: string[] = [];

  /*
   * withProgress() displays a progress notification in VS Code.
   * The callback runs the actual conversion loop.
   *
   * Progress is updated after each image is started.
   */
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'FormatFlip: Converting images',
      cancellable: false,
    },
    async (progress) => {
      for (let index = 0; index < named.length; index++) {
        const item = named[index];

        progress.report({
          message: `${index + 1} of ${named.length}: ${path.basename(item.source)}`,
          increment: 100 / named.length,
        });

        try {
          const result = await convertPath(
            item.source,
            item.name,
            destination,
          );

          succeeded++;
          originalTotal += result.originalBytes;
          convertedTotal += result.convertedBytes;
        } catch (error) {
          // One bad image should not stop the remaining files.
          failed++;

          errors.push(
            `${path.basename(item.source)}: ${errorMessage(error)}`,
          );
        }
      }
    },
  );

  // Build a summary using the actual successful conversions.
  const summary =
    `FormatFlip: ${succeeded} converted, ${failed} failed. ` +
    `${formatBytes(originalTotal)} → ${formatBytes(convertedTotal)} ` +
    `(${formatSavings(originalTotal, convertedTotal)}).`;

  if (failed) {
    void vscode.window.showWarningMessage(
      `${summary} ${errors.slice(0, 2).join(' | ')}`,
    );
  } else {
    void vscode.window.showInformationMessage(summary);
  }
}


// ============================================================
// 8. READING THE WINDOWS CLIPBOARD
// ============================================================

/*
 * This command supports two clipboard situations:
 *
 * A. An image itself was copied, such as a screenshot.
 * B. One or more image files were copied in File Explorer.
 *
 * Windows clipboard access here is implemented using
 * PowerShell because the extension runs on Windows.
 *
 * This command is Windows-specific. The drag-and-drop panel
 * and Explorer conversion use other code paths.
 */
async function saveClipboardImage(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (process.platform !== 'win32') {
    void vscode.window.showErrorMessage(
      'FormatFlip clipboard image capture currently supports Windows. You can still use the drag-and-drop panel on other platforms.',
    );

    return;
  }

  const root = workspaceRoot();

  if (!root) {
    void vscode.window.showErrorMessage(
      'FormatFlip: Open a project folder in VS Code first.',
    );

    return;
  }

  // globalStorageUri is VS Code's extension-specific storage.
  // We temporarily save clipboard screenshots there as PNGs.
  const tempDir = context.globalStorageUri.fsPath;

  await fs.mkdir(tempDir, { recursive: true });

  // Date.now() helps create a different temporary filename
  // for each invocation.
  const tempPng = path.join(
    tempDir,
    `formatflip-clipboard-${Date.now()}.png`,
  );

  try {
    // PowerShell single-quoted strings escape apostrophes
    // by doubling them.
    const escapedPath = tempPng.replace(/'/g, "''");

    /*
     * The PowerShell script:
     *
     * 1. Loads Windows Forms and System.Drawing.
     * 2. Checks whether the clipboard contains copied files.
     * 3. If so, returns their paths as JSON.
     * 4. Otherwise, checks whether it contains an image.
     * 5. If it does, temporarily saves it as PNG.
     * 6. Returns IMAGE or EMPTY to identify the result.
     *
     * -STA requests a single-threaded apartment, which is
     * commonly needed for Windows clipboard operations.
     */
    const script =
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `Add-Type -AssemblyName System.Drawing; ` +
      `$files = [Windows.Forms.Clipboard]::GetFileDropList(); ` +
      `if ($files.Count -gt 0) { ` +
      `ConvertTo-Json -InputObject @($files | ForEach-Object { $_.ToString() }) -Compress ` +
      `} elseif ([Windows.Forms.Clipboard]::ContainsImage()) { ` +
      `[Windows.Forms.Clipboard]::GetImage().Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png); ` +
      `'IMAGE' ` +
      `} else { 'EMPTY' }`;

    // Execute PowerShell and wait for its output.
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );

    const result = stdout.trim();

    // Nothing useful was copied.
    if (result === 'EMPTY' || !result) {
      void vscode.window.showInformationMessage(
        'FormatFlip: Copy an image or image file first, then try again.',
      );

      return;
    }

    // CASE A: The clipboard contains an actual image.
    if (result === 'IMAGE') {
      const destination = await chooseOutputFolder();

      if (!destination) {
        return;
      }

      const name = await vscode.window.showInputBox({
        title: 'Name your WebP image',
        prompt: 'Enter a filename',
        value: 'image',
        validateInput: (value) =>
          value.trim() ? undefined : 'Enter a filename.',
      });

      if (name === undefined) {
        return;
      }

      // Read the temporary PNG and convert its bytes to WebP.
      const buffer = await fs.readFile(tempPng);

      const converted = await convertBuffer(
        buffer,
        name,
        destination,
      );

      void vscode.window.showInformationMessage(
        `FormatFlip: ${path.basename(converted.path)} saved. ` +
        `${formatBytes(converted.originalBytes)} → ` +
        `${formatBytes(converted.convertedBytes)} ` +
        `(${formatSavings(converted.originalBytes, converted.convertedBytes)}).`,
      );

      return;
    }

    // CASE B: The clipboard contains paths to copied files.
    let copiedPaths: string[];

    try {
      // Parse the PowerShell JSON response.
      const parsed: unknown = JSON.parse(result);

      // Accept either a single value or an array of values.
      copiedPaths = (
        Array.isArray(parsed) ? parsed : [parsed]
      ).filter(
        (item): item is string =>
          typeof item === 'string' && isImagePath(item),
      );
    } catch {
      // Invalid JSON means we couldn't extract usable paths.
      copiedPaths = [];
    }

    if (copiedPaths.length === 0) {
      void vscode.window.showWarningMessage(
        'FormatFlip: The clipboard does not contain supported image files.',
      );

      return;
    }

    // Reuse the batch conversion flow for copied image files.
    await promptNamesAndConvert(
      copiedPaths,
      await chooseOutputFolder(),
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `FormatFlip: Could not read the Windows clipboard. ${errorMessage(error)}`,
    );
  } finally {
    /*
     * finally runs whether the try succeeds, returns early,
     * or throws an error.
     *
     * We therefore attempt to remove the temporary PNG.
     * If it doesn't exist, ignore the cleanup error.
     */
    await fs.unlink(tempPng).catch(() => undefined);
  }
}


// ============================================================
// 9. COPYING AN IMAGE PATH
// ============================================================

/*
 * This command is intended for the Explorer context menu.
 *
 * VS Code supplies the selected resource as a vscode.Uri.
 *
 * If the file is inside the workspace, we copy a relative
 * path such as:
 *
 * public/images/logo.webp
 *
 * Relative paths are convenient for HTML, CSS, and React.
 *
 * If the file is outside the workspace, we copy its absolute
 * path instead.
 */
async function copyImagePath(
  uri?: vscode.Uri,
): Promise<void> {
  if (!uri) {
    void vscode.window.showInformationMessage(
      'FormatFlip: Right-click an image in Explorer and choose Copy Image Path.',
    );

    return;
  }

  const root = workspaceRoot();

  const relative =
    root &&
    isPathInside(
      path.resolve(root),
      path.resolve(uri.fsPath),
    )
      ? path.relative(root, uri.fsPath).split(path.sep).join('/')
      : uri.fsPath;

  // VS Code provides a cross-platform clipboard API.
  await vscode.env.clipboard.writeText(relative);

  void vscode.window.showInformationMessage(
    `Copied image path: ${relative}`,
  );
}


// ============================================================
// 10. OPENING THE DRAG-AND-DROP WEBVIEW
// ============================================================

/*
 * A webview lets an extension display a custom HTML interface.
 *
 * This function:
 * 1. Creates the panel.
 * 2. Loads the HTML generated below.
 * 3. Listens for messages sent by the webview.
 * 4. Handles folder selection and conversion requests.
 *
 * The webview itself does not directly write files.
 * It sends messages to this extension code, which performs
 * filesystem operations and image conversion.
 */
function openDropPanel(
  context: vscode.ExtensionContext,
): void {
  const panel = vscode.window.createWebviewPanel(
    'formatflipDropPanel',
    'FormatFlip — Drop & Convert',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  // Generate the HTML and assign it to the webview.
  panel.webview.html = getDropPanelHtml(
    panel.webview,
    context.extensionUri,
  );

  // Remembers the folder chosen in this panel session.
  let chosenFolder: string | undefined;

  /*
   * onDidReceiveMessage() listens for messages from the
   * webview's JavaScript.
   *
   * For example:
   * { type: 'chooseFolder' }
   *
   * or:
   * { type: 'convert', files: [...] }
   */
  panel.webview.onDidReceiveMessage(
    async (message: {
      type?: string;
      files?: PanelFile[];
    }) => {

      // USER CLICKED "CHOOSE FOLDER".
      if (message.type === 'chooseFolder') {
        try {
          chosenFolder = await chooseOutputFolder();

          if (chosenFolder) {
            // Send the selected folder name back to the UI.
            panel.webview.postMessage({
              type: 'folderChosen',
              label: workspaceRelative(chosenFolder),
            });
          }
        } catch (error) {
          void vscode.window.showErrorMessage(
            `FormatFlip: ${errorMessage(error)}`,
          );
        }

        return;
      }

      // USER CLICKED "CONVERT TO WEBP".
      if (message.type === 'convert') {
        const files = Array.isArray(message.files)
          ? message.files
          : [];

        if (files.length === 0) {
          panel.webview.postMessage({
            type: 'status',
            text: 'Add at least one image first.',
            error: true,
          });

          return;
        }

        try {
          /*
           * If no custom folder was chosen, use the default.
           * Validate it again before writing files.
           */
          const destination = await validateOutputFolder(
            chosenFolder ?? await getDefaultOutputFolder(true),
            true,
          );

          chosenFolder = destination;

          let succeeded = 0;
          let failed = 0;
          let originalTotal = 0;
          let convertedTotal = 0;

          // Each result is sent back to the webview for display.
          const results: Array<{
            name: string;
            ok: boolean;
            message: string;
          }> = [];

          // Convert each image separately so one invalid image
          // doesn't prevent the other images from being handled.
          for (const file of files) {
            try {
              if (
                typeof file.base64 !== 'string' ||
                file.base64.length === 0
              ) {
                throw new Error('No image data received.');
              }

              // Decode base64 text back into binary image bytes.
              const buffer = Buffer.from(file.base64, 'base64');

              if (buffer.length === 0) {
                throw new Error('The image file is empty.');
              }

              // Sharp validates and converts the actual image.
              const result = await convertBuffer(
                buffer,
                file.name || 'image',
                destination,
              );

              succeeded++;
              originalTotal += result.originalBytes;
              convertedTotal += result.convertedBytes;

              results.push({
                name: path.basename(result.path),
                ok: true,
                message:
                  `${formatBytes(result.originalBytes)} → ` +
                  `${formatBytes(result.convertedBytes)}`,
              });
            } catch (error) {
              failed++;

              results.push({
                name: file.name || 'Unknown image',
                ok: false,
                message: errorMessage(error),
              });
            }
          }

          // Send the summary and individual results to the UI.
          panel.webview.postMessage({
            type: 'finished',
            results,
            summary:
              `${succeeded} converted, ${failed} failed. ` +
              `${formatBytes(originalTotal)} → ` +
              `${formatBytes(convertedTotal)} ` +
              `(${formatSavings(originalTotal, convertedTotal)}).`,
            folder: workspaceRelative(destination),
          });
        } catch (error) {
          // Report destination or other top-level errors.
          panel.webview.postMessage({
            type: 'status',
            text: errorMessage(error),
            error: true,
          });
        }
      }
    },
    undefined,
    context.subscriptions,
  );
}

/*
 * Converts an absolute folder path into a workspace-relative
 * path for display in the webview.
 *
 * Example:
 * D:\Project\public\images -> public/images
 *
 * If the folder isn't inside the workspace, the function
 * falls back to returning the original path.
 */
function workspaceRelative(folder: string): string {
  const root = workspaceRoot();

  return root &&
    isPathInside(
      path.resolve(root),
      path.resolve(folder),
    )
      ? (
          path.relative(root, folder)
            .split(path.sep)
            .join('/') || '.'
        )
      : folder;
}


// ============================================================
// 11. GENERATING THE WEBVIEW HTML, CSS, AND JAVASCRIPT
// ============================================================

/*
 * This function creates the actual drag-and-drop interface.
 *
 * It contains three web technologies:
 *
 * HTML:
 * Defines buttons, the drop zone, file list, and status area.
 *
 * CSS:
 * Controls layout, colours, borders, and responsive styling.
 *
 * JavaScript:
 * Handles file selection, drag-and-drop, renaming, removal,
 * and communication with the extension.
 *
 * This is one large template string because the webview needs
 * a complete HTML document.
 *
 * IMPORTANT:
 * Webview JavaScript and extension TypeScript run in
 * different contexts. They communicate through messages.
 */
function getDropPanelHtml(
  webview: vscode.Webview,
  _extensionUri: vscode.Uri,
): string {

  /*
   * CSP stands for Content Security Policy.
   *
   * The nonce is a random token added to this document.
   * The policy allows this document's script and style
   * elements only when they contain the matching nonce.
   *
   * This helps prevent unwanted scripts and styles from
   * being injected into the webview.
   */
  const nonce = [...Array(32)]
    .map(() =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        .charAt(Math.floor(Math.random() * 62)),
    )
    .join('');

  const csp =
    `default-src 'none'; ` +
    `img-src data: blob:; ` +
    `style-src 'nonce-${nonce}'; ` +
    `script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FormatFlip</title>

<!-- CSS: styles the panel using the active VS Code theme. -->
<style nonce="${nonce}">
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:22px;max-width:900px;margin:0 auto}
.brand{font-size:25px;font-weight:750;letter-spacing:-.8px}
.brand span{color:var(--vscode-textLink-foreground)}
.sub{opacity:.75;margin:6px 0 22px}
.drop{border:2px dashed var(--vscode-panel-border);border-radius:16px;padding:32px 18px;text-align:center;background:var(--vscode-sideBar-background);transition:border-color .15s,background .15s}
.drop.over{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}
.drop strong{display:block;font-size:17px;margin-bottom:8px}
.muted{opacity:.7;font-size:12px}
.button{border:1px solid var(--vscode-button-border,transparent);border-radius:7px;padding:8px 13px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font:inherit}
.button:hover{background:var(--vscode-button-hoverBackground)}
.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.destination{margin:16px 0;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:9px;display:flex;justify-content:space-between;align-items:center;gap:12px}
.files{display:grid;gap:9px;margin:16px 0}
.file{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,1fr) auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:9px}
.filetitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name{width:100%;min-width:0;padding:8px;border-radius:6px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}
.remove{border:0;background:transparent;color:var(--vscode-descriptionForeground);cursor:pointer;font-size:18px}
.status{margin-top:14px;padding:12px;border-radius:8px;background:var(--vscode-textBlockQuote-background);white-space:pre-wrap}
.status.error{color:var(--vscode-errorForeground)}
.result{font-size:12px;opacity:.8}
.footer{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}
@media(max-width:560px){
.file{grid-template-columns:1fr auto}
.file .name{grid-column:1}
.file .remove{grid-column:2;grid-row:1}
.destination{align-items:flex-start;flex-direction:column}
}
</style>
</head>

<body>

<!-- HTML: the visible FormatFlip interface. -->
<div class="brand">Format<span>Flip</span></div>

<div class="sub">
Drop images. Rename them. Save lighter WebP files straight into your project.
</div>

<!-- Users can drop images here or use the file picker. -->
<div class="drop" id="drop">
  <strong>Drop one or more images here</strong>
  <div class="muted">PNG, JPG, JPEG, WebP, BMP, GIF and TIFF</div>

  <div style="margin-top:16px">
    <button class="button" id="browse">Choose images</button>

    <!--
      The input is hidden because we use our own button.
      "multiple" allows the user to select several files.
    -->
    <input
      id="picker"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,image/tiff"
      multiple
      hidden
    >
  </div>
</div>

<!-- Shows the currently selected output directory. -->
<div class="destination">
  <div>
    <div class="muted">SAVE TO</div>
    <strong id="folderLabel">Default folder: public/images</strong>
  </div>

  <button class="button secondary" id="chooseFolder">
    Choose folder
  </button>
</div>

<!-- JavaScript inserts one row per selected image here. -->
<div class="files" id="files"></div>

<div class="footer">
  <div class="muted" id="count">No images added yet.</div>
  <button class="button" id="convert" disabled>
    Convert to WebP
  </button>
</div>

<!-- Displays errors, progress messages, and conversion results. -->
<div class="status" id="status" hidden></div>

<!-- JavaScript: behaviour of the webview interface. -->
<script nonce="${nonce}">

/*
 * acquireVsCodeApi() provides the webview with a way to
 * exchange messages with the extension.
 *
 * vscode.postMessage(...) sends data to extension.ts.
 *
 * The extension can send messages back using postMessage().
 */
const vscode = acquireVsCodeApi();

// Grab the HTML elements once so we can update them later.
const drop = document.getElementById('drop');
const picker = document.getElementById('picker');
const filesEl = document.getElementById('files');
const countEl = document.getElementById('count');
const convertBtn = document.getElementById('convert');
const statusEl = document.getElementById('status');
const folderLabel = document.getElementById('folderLabel');

// items holds the images currently waiting to be converted.
//
// Each item contains:
// id       -> unique identifier for this UI row
// original -> original filename
// name     -> user-editable output filename
// base64   -> image bytes encoded as text for messaging
let items = [];

// Used to give each selected image a unique UI identifier.
let nextId = 1;

// Basic extension check before reading an image.
// Sharp performs the more important actual format validation.
const allowed = /\\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;

/*
 * Shows a status message.
 *
 * error=false displays a normal message.
 * error=true applies the error styling.
 */
function showStatus(text, error=false) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = 'status' + (error ? ' error' : '');
}

/*
 * Reads a browser File object and converts its data to base64.
 *
 * FileReader is a browser API available in the webview.
 * readAsDataURL() produces a value such as:
 *
 * data:image/png;base64,AAAA...
 *
 * We remove everything up to the comma and send only the
 * base64 portion to extension.ts.
 *
 * A Promise lets us await the asynchronous file read.
 */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');

      if (comma < 0) {
        reject(new Error('Could not read ' + file.name));
      } else {
        resolve(result.slice(comma + 1));
      }
    };

    reader.onerror = () => {
      reject(new Error('Could not read ' + file.name));
    };

    reader.readAsDataURL(file);
  });
}

/*
 * Adds selected or dropped files to the items array.
 *
 * Array.from() converts a FileList into a normal array.
 * We process each file, check its extension, and read it.
 *
 * Once finished, render() redraws the file list.
 */
async function addFiles(fileList) {
  statusEl.hidden = true;

  const incoming = Array.from(fileList || []);
  let added = 0;

  for (const file of incoming) {
    if (!allowed.test(file.name)) {
      showStatus('Skipped unsupported file: ' + file.name, true);
      continue;
    }

    try {
      const base64 = await readFile(file);

      items.push({
        id: nextId++,
        original: file.name,

        // Start with the original name, without its extension.
        name: file.name
          .replace(/\\.[^.]+$/, '')
          .replace(/\\.webp$/i, ''),

        base64
      });

      added++;
    } catch (error) {
      showStatus(String(error), true);
    }
  }

  render();

  if (added) {
    showStatus(
      added + ' image(s) ready. Edit each filename before converting.'
    );
  }
}

/*
 * Rebuilds the visible list of selected images.
 *
 * For every item:
 * - Create a row.
 * - Display the original filename.
 * - Add an editable output-name field.
 * - Add a remove button.
 *
 * createElement() creates HTML elements.
 * textContent safely inserts text instead of interpreting
 * a filename as HTML.
 */
function render() {
  // Clear the existing rows before rebuilding them.
  filesEl.innerHTML = '';

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'file';

    const title = document.createElement('div');
    title.className = 'filetitle';
    title.textContent = item.original;
    title.title = item.original;

    const input = document.createElement('input');
    input.className = 'name';
    input.value = item.name;

    input.setAttribute(
      'aria-label',
      'Output filename for ' + item.original
    );

    // Keep the item's name updated as the user types.
    input.addEventListener('input', () => {
      item.name = input.value;
    });

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = '×';
    remove.title = 'Remove image';

    remove.setAttribute(
      'aria-label',
      'Remove ' + item.original
    );

    // Remove this image from the array, then redraw the list.
    remove.addEventListener('click', () => {
      items = items.filter(x => x.id !== item.id);
      render();
    });

    // Add all three elements to the row.
    row.append(title, input, remove);

    // Add the row to the visible file list.
    filesEl.appendChild(row);
  });

  // Update the image count.
  countEl.textContent = items.length
    ? items.length + ' image(s) selected — rename each one below.'
    : 'No images added yet.';

  // Disable conversion when there are no selected images.
  convertBtn.disabled = items.length === 0;
}

/*
 * When the custom button is clicked, open the hidden
 * browser file picker.
 */
document.getElementById('browse').addEventListener(
  'click',
  () => picker.click()
);

/*
 * The change event fires after files are selected.
 *
 * We add the selected files and reset the input so that
 * choosing the same file again can trigger another change.
 */
picker.addEventListener('change', async () => {
  await addFiles(picker.files);
  picker.value = '';
});

/*
 * Drag-and-drop has several events.
 *
 * dragenter and dragover prevent the browser's default
 * handling and highlight the drop zone.
 *
 * dragleave and drop remove the highlight.
 */
for (const eventName of ['dragenter', 'dragover']) {
  drop.addEventListener(eventName, event => {
    event.preventDefault();
    drop.classList.add('over');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  drop.addEventListener(eventName, event => {
    event.preventDefault();
    drop.classList.remove('over');
  });
}

/*
 * When files are dropped, the browser exposes them through
 * event.dataTransfer.files.
 *
 * We pass that FileList into the same addFiles() function
 * used by the normal file picker.
 */
drop.addEventListener('drop', event => {
  addFiles(event.dataTransfer.files);
});

/*
 * Ask extension.ts to open the output-folder selection UI.
 *
 * The webview cannot directly use VS Code's native folder
 * picker, so it sends a message to the extension.
 */
document.getElementById('chooseFolder').addEventListener(
  'click',
  () => vscode.postMessage({ type: 'chooseFolder' })
);

/*
 * Start the conversion process.
 *
 * Before sending the request:
 * - Make sure there are images.
 * - Make sure every filename is non-empty.
 * - Disable the button to reduce accidental repeat clicks.
 * - Show a status message.
 *
 * The image data and filenames are then sent to extension.ts.
 */
convertBtn.addEventListener('click', () => {
  if (!items.length) {
    return;
  }

  for (const item of items) {
    if (!item.name.trim()) {
      showStatus('Every image needs a filename.', true);
      return;
    }
  }

  convertBtn.disabled = true;
  showStatus('Converting images…');

  vscode.postMessage({
    type: 'convert',

    // Send only the fields required by the extension.
    files: items.map(item => ({
      name: item.name,
      base64: item.base64
    }))
  });
});

/*
 * Listen for messages sent back from extension.ts.
 *
 * folderChosen:
 *   Update the displayed output directory.
 *
 * status:
 *   Display an error or other status message.
 *
 * finished:
 *   Display the conversion summary and individual results.
 */
window.addEventListener('message', event => {
  const message = event.data;

  if (message.type === 'folderChosen') {
    folderLabel.textContent = 'Folder: ' + message.label;
  } else if (message.type === 'status') {
    showStatus(message.text, !!message.error);
    convertBtn.disabled = items.length === 0;
  } else if (message.type === 'finished') {
    const lines = (message.results || []).map(
      result =>
        (result.ok ? '✓ ' : '✕ ') +
        result.name +
        ' — ' +
        result.message
    );

    showStatus(
      message.summary +
      '\\nSaved to: ' +
      message.folder +
      '\\n\\n' +
      lines.join('\\n'),

      // Show error styling if any image failed.
      (message.results || []).some(result => !result.ok)
    );

    // Allow the user to convert again if images remain.
    convertBtn.disabled = items.length === 0;
  }
});
</script>
</body>
</html>`;
}


// ============================================================
// 12. ERROR HANDLING HELPER
// ============================================================

/*
 * JavaScript and TypeScript can throw different kinds of
 * values. An error is not guaranteed to be an Error object.
 *
 * If it is an Error, use its readable message.
 * Otherwise, convert the value to a string.
 *
 * This gives our notifications a useful error description.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String(error);
}
