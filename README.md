<p align="center">
  <img src="src/assets/formatflip-icon.png" width="128" height="128" alt="FormatFlip Icon">
</p>

#  FormatFlip

### Flip your images. Keep your flow.

**Convert images to WebP without leaving Visual Studio Code.**

FormatFlip is a lightweight VS Code extension that brings image conversion directly into your development workflow. Convert images from the Explorer, use the clipboard workflow, or drag and drop images into the conversion panel — all without switching applications.

Spend less time managing images and more time building things.

---

##  Features

-  **Convert from Explorer** — Right-click supported image files and convert them to WebP.
-  **Clipboard Conversion** — Save clipboard images as WebP using the extension's clipboard workflow.
-  **Drag & Drop** — Drop images into the FormatFlip panel for convenient conversion.
-  **Batch Conversion** — Convert selected images together and handle filenames during batch processing.
-  **Smart Filename Handling** — Keep existing files safe. If `photo.webp` already exists, FormatFlip generates an alternative such as `photo-1.webp`.
-  **Image Size Statistics** — See how much space your converted images save.
-  **Custom Output Directory** — Configure the default destination for converted images.
-  **Adjustable Quality** — Configure WebP quality to balance image quality and file size.
-  **Copy Image Path** — Copy an image's path for use in your project.
-  **Helpful Error Messages** — Unsupported files and corrupted images are rejected instead of being treated as successful conversions.

##  Get Started

1. Install FormatFlip in Visual Studio Code.
2. Open a project containing images.
3. Right-click an image in the Explorer.
4. Select **FormatFlip: Convert Selected Images to WebP**.
5. Find your converted image in the configured output directory.

### Prefer shortcuts?

| Action | Windows / Linux |
|---|---|
| Save clipboard image as WebP | `Ctrl + Alt + W` |
| Open drag-and-drop panel | `Ctrl + Alt + P` |

You can also open the Command Palette with `Ctrl + Shift + P` and search for **FormatFlip**.

## 🧩 Built for your workflow

Whether you're optimizing images for a website, preparing assets for a portfolio, or organizing images in a project, FormatFlip keeps the conversion process close to your code.

**Your images stay yours:** FormatFlip is designed to preserve the original image files when creating converted outputs.

## 🖼️ Supported Images

FormatFlip uses [Sharp](https://sharp.pixelplumbing.com/) for image processing.

Supported input formats depend on the formats accepted by Sharp and the extension's validation. Unsupported files, such as PDFs, and invalid or corrupted images are handled with an error message.

## ⚙️ Configuration

Open **Settings** in VS Code and search for `FormatFlip`.

| Setting | Default | Description |
|---|---|---|
| `formatflip.outputDirectory` | `public/images` | Default workspace-relative output directory |
| `formatflip.quality` | `82` | WebP quality from 1 to 100 |

Higher quality generally preserves more image detail but may produce larger files. The best value depends on the image and your needs.

## ⌨️ Commands

Open the Command Palette with `Ctrl + Shift + P` and search for these commands:

- `FormatFlip: Open Drag-and-Drop Panel`
- `FormatFlip: Convert Selected Images to WebP`
- `FormatFlip: Save Clipboard Image as WebP`
- `FormatFlip: Copy Image Path`

## 🛠️ Development

Want to explore the code or contribute? Get started locally.

### Requirements

- [Node.js](https://nodejs.org/)
- [Visual Studio Code](https://code.visualstudio.com/)
- npm

### Setup

```bash
git clone https://github.com/ElrheaDeSouza/formatflip-vscode
cd formatflip
npm install
```

Compile and check the project:

```bash
npm run compile
```

Run the tests:

```bash
npm test
```

To launch the extension during development, open the project in VS Code and press `F5`. This opens an **Extension Development Host** where you can test FormatFlip.

### Package locally

Create an installable VS Code extension package:

```bash
npx vsce package
```

VS Code generates a `.vsix` file that you can install to test the packaged extension.

## 🧪 Testing

FormatFlip has been manually tested in a real VS Code project for:

- Explorer-based image conversion
- Preservation of original image files
- Duplicate output filename handling
- Unsupported PDF rejection
- Clipboard conversion
- Drag-and-drop conversion
- Invalid image handling

Automated tests currently cover extension activation and image paste provider registration.

## 🎨 Icon Credits

The FormatFlip application icon was created using **[IconKitchen — App Icon Generator](https://icon.kitchen/)**, which helped generate the icon artwork for the project.

## 📄 License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

**Made for developers who like their workflow as smooth as their WebP files. ⚡**

If FormatFlip helps your workflow, consider ⭐ starring the repository and sharing feedback or ideas for improvement.
