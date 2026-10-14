import { expect, test } from 'vitest';
import { actionName } from '../src/pages/listen/action-name.ts';

test('names an action by its app and what it does', () => {
  expect(actionName('gmail-send-email')).toBe('Gmail · Send email');
  expect(actionName('google_calendar-create-event')).toBe('Google Calendar · Create event');
});

test('a key without an action, or with stray separators, still reads', () => {
  expect(actionName('slack')).toBe('Slack');
  expect(actionName('notion-')).toBe('Notion');
  expect(actionName('')).toBe('');
});
