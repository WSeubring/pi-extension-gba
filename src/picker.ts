import { SelectList } from "@mariozechner/pi-tui";
import type { SelectItem, SelectListTheme } from "@mariozechner/pi-tui";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { Theme } from "@mariozechner/pi-coding-agent";

export interface PickerResult {
  cancelled: boolean;
  basename?: string;
}

function themeAdapter(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("muted", text),
    noMatch: (text: string) => theme.fg("muted", text),
  };
}

export async function showRomPicker(
  ctx: ExtensionCommandContext,
  roms: string[],
): Promise<PickerResult> {
  return ctx.ui.custom<PickerResult>(
    (_tui, theme, _kb, done) => {
      const items: SelectItem[] = roms.map((r) => ({ value: r, label: r }));
      const list = new SelectList(items, 10, themeAdapter(theme));
      list.onSelect = (item) => done({ cancelled: false, basename: item.value });
      list.onCancel = () => done({ cancelled: true });
      return list;
    },
    { overlay: true },
  );
}
