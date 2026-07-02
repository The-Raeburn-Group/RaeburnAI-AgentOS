import { expect, test } from '@playwright/test';

test('dashboard loads with product positioning', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /operating system for dependable AI agents/i })).toBeVisible();
  await expect(page.getByText('Agent marketplace')).toBeVisible();
  await expect(page.getByText('Human approvals')).toBeVisible();
});
