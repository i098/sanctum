const words = (slug: string): string[] => slug.split(/[_-]+/).filter(Boolean);
const upper = (word: string): string => word[0]!.toUpperCase() + word.slice(1);

/** A Pipedream action key is `<app>-<action>`: `google_calendar-create-event` reads "Google Calendar · Create event". */
export function actionName(key: string): string {
  const [app = '', ...rest] = key.split('-');
  const action = words(rest.join('-')).join(' ').toLowerCase();
  const name = words(app).map(upper).join(' ');
  return action === '' ? name : `${name} · ${upper(action)}`;
}
