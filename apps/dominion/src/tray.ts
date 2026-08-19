import SysTray from 'systray2';
import type { ClickEvent } from 'systray2';

export interface TrayOptions {
  port: number;
  onOpen: () => void;
  onQuit: () => void;
}

export function initTray(options: TrayOptions): void {
  // Base64-encoded minimal 16x16 PNG icon (simple solid square placeholder)
  const iconBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAN0lEQVQ4T2NkoBAwUqifYdQAg98A' +
    'BoIGMBAw/CdgAAMBw38CBjAQMPwnYAADAcN/AgYwEDD8JwAACAAJ/wABzgAAAABJRU5ErkJggg==';

  const tray = new SysTray({
    menu: {
      icon: iconBase64,
      isTemplateIcon: false,
      title: 'Dominion',
      tooltip: 'The Dominion',
      items: [
        {
          title: 'Open Dashboard',
          tooltip: `Open dashboard at http://localhost:${options.port}`,
          checked: false,
          enabled: true,
        },
        SysTray.separator,
        {
          title: 'Quit',
          tooltip: 'Stop The Dominion',
          checked: false,
          enabled: true,
        },
      ],
    },
    debug: false,
    copyDir: true,
  });

  void tray.onClick((action: ClickEvent) => {
    if (action.seq_id === 0) {
      options.onOpen();
    } else if (action.seq_id === 2) {
      options.onQuit();
      void tray.kill(false);
    }
  });
}
