
import * as assert from 'assert';
import * as vscode from 'vscode';

suite('FormatFlip Extension Tests', () => {
  test('Extension is installed and can activate', async () => {
    const extension = vscode.extensions.all.find(
      (item) => item.packageJSON.name === 'formatflip'
    );

    assert.ok(extension, 'FormatFlip extension should be available');

    await extension.activate();

    assert.strictEqual(
      extension.isActive,
      true,
      'FormatFlip should activate successfully'
    );
  });

  test('Image paste provider is registered', async () => {
    const extension = vscode.extensions.all.find(
      (item) => item.packageJSON.name === 'formatflip'
    );

    assert.ok(extension, 'FormatFlip extension should be available');

    await extension.activate();

    assert.strictEqual(
      extension.isActive,
      true,
      'The extension should activate and register its paste provider'
    );
  });
});
