import { expect, test } from 'vitest';
import { actionLabel, actionName, appName } from '../src/lib/action-label.ts';

test('names an action by its app and what it does', () => {
  expect(actionName('gmail-send-email')).toBe('Gmail · Send email');
  expect(actionName('google_calendar-create-event')).toBe('Google Calendar · Create event');
  expect(actionName('github-create-issue')).toBe('GitHub · Create issue');
});

test('labels an action without its app', () => {
  expect(actionLabel('gmail-send-email')).toBe('Send email');
  expect(actionLabel('google_calendar-create_event')).toBe('Create event');
  expect(actionLabel('slack')).toBe('Slack');
});

test('a key without an action, or with stray separators, still reads', () => {
  expect(actionName('slack')).toBe('Slack');
  expect(actionName('notion-')).toBe('Notion');
  expect(actionLabel('notion-')).toBe('Notion');
  expect(actionName('')).toBe('');
  expect(appName('google_docs')).toBe('Google Docs');
});
