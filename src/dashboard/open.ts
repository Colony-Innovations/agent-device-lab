import { spawn } from 'node:child_process';

/** Whether a desktop browser can be opened from this process. */
export function hasDisplay(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Open a URL in the user's browser without waiting for it. Returns false when there is no display. */
export function openInBrowser(url: string): boolean {
  if (!hasDisplay()) return false;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
