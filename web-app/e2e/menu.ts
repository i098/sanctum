import type { Locator, Page } from '@playwright/test';

/** One section of the Menu panel, by its rail name (Meetings, Agents, Settings). */
export const menuSection = (page: Page, section: string): Locator => page.getByRole('dialog', { name: 'Menu' }).getByRole('region', { name: section });

/** Opens the Menu panel from the footer and shows one section; returns that section. */
export async function openMenu(page: Page, section: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('navigation', { name: 'Menu sections' }).getByRole('button', { name: section }).click();
  return menuSection(page, section);
}
