const { test, expect } = require('@playwright/test');

test.describe('Autoryzacja (Login i Logout)', () => {
  test('Powinno wyświetlić stronę logowania i zalogować administratora bez 2FA', async ({ page }) => {
    // 1. Wejście na stronę główną
    await page.goto('/');

    // Zweryfikuj nagłówek strony logowania
    await expect(page.locator('h2')).toContainText('Dietetyk AI');
    await expect(page.locator('p')).toContainText('Twój osobisty asystent żywieniowy.');

    // 2. Wypełnienie formularza logowania dla admina
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');

    // 3. Kliknięcie "Dalej" / Zaloguj
    await page.click('button:has-text("Dalej")');

    // 4. Powinniśmy znaleźć się na Dashboardzie (brak 2FA dla admina)
    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
    await expect(page.locator('.nav-tab.active')).toContainText('Dashboard');
    await expect(page.locator('.dietetyk-greeting')).toBeVisible();

    // 5. Wylogowanie
    await page.click('button:has-text("Wyloguj")');

    // 6. Powrót do strony logowania
    await expect(page.locator('h2')).toContainText('Dietetyk AI');
  });

  test('Powinno zalogować administratora przy użyciu adresu e-mail', async ({ page }) => {
    await page.goto('/');
    // Używamy e-maila admina zamiast nazwy użytkownika
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'admin@dietetyk-ai.local');
    await page.fill('input[placeholder="Wpisz hasło..."]', '3bda877d518c8cf7a80b32bb');
    await page.click('button:has-text("Dalej")');

    await expect(page.locator('.logo-text')).toContainText('Dietetyk AI');
    await expect(page.locator('.nav-tab.active')).toContainText('Dashboard');
    
    // Wylogowanie
    await page.click('button:has-text("Wyloguj")');
    await expect(page.locator('h2')).toContainText('Dietetyk AI');
  });

  test('Powinno pokazać błąd przy niepoprawnych danych logowania', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[placeholder="Wpisz login lub e-mail..."]', 'nieistniejacy_user');
    await page.fill('input[placeholder="Wpisz hasło..."]', 'blednehaslo');
    await page.click('button:has-text("Dalej")');

    // Weryfikacja komunikatu o błędzie
    await expect(page.locator('.alert-error')).toBeVisible();
    await expect(page.locator('.alert-error')).toContainText('Niepoprawny użytkownik lub hasło');
  });
});
