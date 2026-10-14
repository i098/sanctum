/** Slugs whose title-cased words are not the brand's spelling. */
const BRAND: Readonly<Record<string, string>> = { github: 'GitHub' };

const words = (slug: string): string[] => slug.split(/[_-]+/).filter(Boolean);
export const upper = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** A Pipedream app slug as its name: `google_calendar` is `Google Calendar`. */
export const appName = (slug: string): string => BRAND[slug] ?? words(slug).map(upper).join(' ');

const operation = (key: string): string => {
  const [, ...rest] = key.split('-');
  return upper(words(rest.join('-')).join(' ').toLowerCase());
};

/** A Pipedream action key `<app>-<operation>` without its app: `gmail-send-email` is `Send email`; a bare app key is the app. */
export const actionLabel = (key: string): string => operation(key) || appName(key.split('-')[0] ?? '');

/** A Pipedream action key with its app: `google_calendar-create-event` is `Google Calendar · Create event`. */
export function actionName(key: string): string {
  const app = appName(key.split('-')[0] ?? '');
  const action = operation(key);
  return action === '' ? app : `${app} · ${action}`;
}
