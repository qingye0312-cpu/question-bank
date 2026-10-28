import {invoke, isTauri} from '@tauri-apps/api/core';
export async function copyText(text: string): Promise<void> {
  if (isTauri()) await invoke('clipboard_write_text',{text});
  else await navigator.clipboard.writeText(text);
}
