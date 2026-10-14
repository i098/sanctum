/** A Pipedream action key read as words, without its app: `gmail-send-email` is `Send email`; a bare app key is the app. */
export function actionLabel(key: string): string {
  const [app = '', ...operation] = key.replaceAll('_', ' ').split('-');
  const words = operation.length === 0 ? app : operation.join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
