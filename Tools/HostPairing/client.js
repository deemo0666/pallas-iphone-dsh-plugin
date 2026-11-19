window.__ModuleLoader__.load({
  id: 'dsh-local-pair',
  factory: (require) => {
    const { createElement } = require('react');
    const launcherCSS = `
      .pallas-iphone-launcher, .pallas-iphone-launcher:visited {
        display: flex;
        align-items: center;
        gap: 8px;
        box-sizing: border-box;
        width: calc(100% - 4px);
        min-width: 0;
        min-height: 38px;
        margin: 3px 2px;
        padding: 4px 8px;
        border: 1px solid var(--dsw-alias-border-primary, color-mix(in srgb, currentColor 12%, transparent));
        border-radius: var(--dsw-radius-md, 8px);
        color: var(--dsw-alias-label-primary, inherit);
        background: color-mix(in srgb, currentColor 3%, transparent);
        font: inherit;
        text-decoration: none;
      }
      .pallas-iphone-launcher:hover {
        background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent));
        text-decoration: none;
      }
      .pallas-iphone-launcher:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, currentColor);
        outline-offset: -2px;
      }
      .pallas-iphone-launcher[data-compact='true'] {
        justify-content: center;
        width: 36px;
        min-height: 36px;
        margin-inline: 0;
        padding: 0;
      }
      .pallas-iphone-launcher-icon {
        position: relative;
        flex: none;
        width: 26px;
        height: 26px;
        border-radius: 7px;
        color: var(--dsw-alias-state-business-primary, #4285cf);
        background: color-mix(in srgb, currentColor 13%, transparent);
      }
      .pallas-iphone-launcher-icon::before, .pallas-iphone-launcher-icon::after {
        content: '';
        position: absolute;
        box-sizing: border-box;
        left: 50%;
        transform: translateX(-50%);
      }
      .pallas-iphone-launcher-icon::before {
        top: 5px;
        width: 10px;
        height: 16px;
        border: 1.5px solid currentColor;
        border-radius: 2.5px;
      }
      .pallas-iphone-launcher-icon::after {
        bottom: 8px;
        width: 3px;
        height: 1.5px;
        border-radius: 1px;
        background: currentColor;
      }
      .pallas-iphone-launcher-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 500;
      }
      .pallas-iphone-launcher-arrow {
        flex: none;
        margin-inline-start: auto;
        color: var(--dsw-alias-label-secondary, currentColor);
      }
    `;

    function PhoneLauncher({ wide = true } = {}) {
      const label = navigator.language.startsWith('zh') ? 'Pallas iPhone 操控' : 'Pallas iPhone Control';
      return createElement('a', {
        className: 'pallas-iphone-launcher', href: '/dsh-local-pair', target: '_blank', rel: 'noopener noreferrer',
        'data-compact': !wide, 'aria-label': label, title: wide ? undefined : label,
      },
      createElement('span', { className: 'pallas-iphone-launcher-icon', 'aria-hidden': true }),
      wide && createElement('span', { className: 'pallas-iphone-launcher-title' }, label),
      wide && createElement('span', { className: 'pallas-iphone-launcher-arrow', 'aria-hidden': true }, '↗'));
    }

    return {
      name: 'dsh-local-pair',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = launcherCSS;
          document.head.append(style);
          return () => style.remove();
        });
        ctx.effect(() =>
          ctx.slots.inject('sidebar.footer.action', () =>
            ctx.slots.register({ name: 'sidebar.footer.action', id: 'dsh-local-pair' }, PhoneLauncher),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject('settings.plugins.tab', () =>
            ctx.slots.register({ name: 'settings.plugins.tab', id: 'dsh-local-pair', order: 12, label: 'Pallas iPhone' }, () =>
              createElement('iframe', {
                title: 'Pallas iPhone', src: '/dsh-local-pair?embedded=1',
                style: { display: 'block', width: '100%', height: 'min(710px, 70vh)', border: 0 },
              }),
            ),
          ),
        );
      },
    };
  },
});
