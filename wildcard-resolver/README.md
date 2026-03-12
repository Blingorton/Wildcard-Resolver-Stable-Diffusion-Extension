# Wildcard Resolver — SD WebUI Extension

Interactive wildcard resolution for AUTOMATIC1111 / reForge prompt boxes.

## What it does

- **Double-click** any `~~wildcard~~` token in a prompt → see a scrollable list of its entries
- **Click an entry** → replaces the token in-place with your chosen text
- Replacement text may itself contain wildcards — **double-click those too** to chain
- **Right-click** any resolved span → option to **revert** it (also reverts child resolutions)
- Unresolved wildcards pass through unchanged to sd-dynamic-prompts as normal

## Installation

1. Copy the `wildcard-resolver/` folder into your `extensions/` directory:
   ```
   extensions/
     wildcard-resolver/
       scripts/wildcard_resolver.py
       javascript/wildcard_resolver.js
       style.css
       README.md
   ```
2. Restart the WebUI
3. The extension appears as a collapsible **"Wildcard Resolver"** accordion in txt2img and img2img tabs

## Wildcard directory

The extension automatically detects your wildcard folder in this order:

1. `~/.wildcard_editor/config.json` → `wc_dir` key (if you use the companion Wildcard Editor app)
2. `extensions/sd-dynamic-prompts/wildcards/` (default sd-dynamic-prompts location)
3. Your home directory as fallback

The detected path is shown in the accordion. You can refresh it with the ⟳ button.

## Usage

1. Type a prompt with wildcards: `a photo of ~~character~~ in ~~background~~`
2. Double-click `~~character~~` → popup appears with file contents
3. Select an entry, e.g. `~~color~~ power ranger`
4. The token is replaced: `a photo of ~~color~~ power ranger in ~~background~~`
5. Double-click `~~color~~` → select e.g. `red`
6. Result: `a photo of red power ranger in ~~background~~`
7. Right-click `red power ranger` → "Revert to ~~color~~" removes just that resolution
8. Right-click the full `red power ranger` span (if it was itself inserted) → reverts to `~~character~~`

## Notes

- Works on both the positive and negative prompt boxes
- Popup supports keyboard navigation: ↑↓ arrows, Enter to select, Escape to close
- Popup is scrollable for wildcards with 100+ entries
- Empty lines and duplicates are filtered from wildcard files
- Wildcard name matching is case-insensitive
- Does not modify any wildcard files on disk

## Compatibility

- AUTOMATIC1111 WebUI 1.7+
- reForge
- Requires sd-dynamic-prompts for the wildcards themselves (this extension does not process them)
