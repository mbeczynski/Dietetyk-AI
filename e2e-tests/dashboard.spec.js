const { test, expect } = require('@playwright/test');

test.describe('Dashboard i Funkcjonalność UI', () => {
  // Zaloguj się przed każdym testem w tym bloku
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz nazwę użytkownika..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
  });

  test('Weryfikacja układu i braku rozjechania w premium dashboard', async ({ page }) => {
    // Sprawdzenie obecności głównych kolumn i baneru
    const banner = page.locator('.dietetyk-ai-banner');
    await expect(banner).toBeVisible();

    // Sprawdzenie statusu synchronizacji - upewnienie się, że gridColumn: 'span 2' jest obecny w stylu
    const syncStatus = page.locator('[data-testid="status-sync-bar"]');
    await expect(syncStatus).toBeVisible();

    const styleAttr = await syncStatus.getAttribute('style');
    expect(styleAttr).toContain('grid-column: span 2');

    // Sprawdzenie kolumn dashboardu
    const columns = page.locator('.dashboard-column');
    await expect(columns).toHaveCount(2);
  });

  test('Obsługa licznika nawodnienia (Dodawanie i Reset wody)', async ({ page }) => {
    // 1. Zlokalizuj kartę nawodnienia
    const waterCard = page.locator('.premium-card:has-text("💧 Nawodnienie")');
    await expect(waterCard).toBeVisible();

    // Opcjonalnie zresetuj na start, by mieć stabilny stan początkowy
    const resetButton = waterCard.locator('button:has-text("Reset")');
    await resetButton.click();
    await page.waitForTimeout(500); // krótka pauza na aktualizację stanu bazy

    // 2. Sprawdź początkową wartość
    await expect(waterCard).toContainText('0 /');

    // 3. Kliknij "+250 ml"
    const add250Button = waterCard.locator('button:has-text("+250 ml")');
    await add250Button.click();

    // Weryfikacja zmiany w UI
    await expect(waterCard).toContainText('250 /');

    // 4. Kliknij "+500 ml"
    const add500Button = waterCard.locator('button:has-text("+500 ml")');
    await add500Button.click();

    // Weryfikacja (250 + 500 = 750)
    await expect(waterCard).toContainText('750 /');

    // 5. Reset licznika wody
    await resetButton.click();
    await expect(waterCard).toContainText('0 /');
  });

  test('Nawigacja po zakładkach aplikacji', async ({ page }) => {
    const tabs = ['Dziennik Posiłków', 'Trendy', 'Aktywność', 'Ustawienia'];

    for (const tabName of tabs) {
      // Kliknij zakładkę
      await page.click(`.nav-tab:has-text("${tabName}")`);
      
      // Sprawdź czy zakładka jest aktywna
      const activeTab = page.locator('.nav-tab.active');
      await expect(activeTab).toContainText(tabName);

      // Dodatkowe sprawdzenia renderowania komponentów dla danej zakładki
      if (tabName === 'Dziennik Posiłków') {
        await expect(page.locator('.logger-card')).toBeVisible();
      } else if (tabName === 'Trendy') {
        await expect(page.locator('h2:has-text("Twoje wykresy")')).toBeVisible();
      } else if (tabName === 'Aktywność') {
        await expect(page.locator('h3:has-text("Cele Aktywności")')).toBeVisible();
      } else if (tabName === 'Ustawienia') {
        await expect(page.locator('h3:has-text("Twój Profil i Avatar")')).toBeVisible();
      }
    }
  });
});
