import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const appPath = '/ai-math-training/'

test.beforeEach(async ({ page }) => {
  await page.goto(appPath)
  await page.evaluate(() => window.localStorage.clear())
  await page.reload()
})

test('completes an addition session entirely from the keyboard', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Sharpen your number sense.' })).toBeVisible()
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start practice/ }).click()

  const input = page.getByLabel('Your answer')
  await expect(input).toBeFocused()
  const expression = await page.locator('.expression__pieces').innerText()
  const operands = expression.match(/\d+/g)?.map(Number) ?? []
  expect(operands).toHaveLength(2)

  await input.fill(String((operands[0] ?? 0) + (operands[1] ?? 0)))
  await input.press('Enter')
  await expect(page.getByText('Correct.', { exact: true })).toBeVisible()
  await expect(input).toHaveAttribute('readonly', '')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Perfect run!' })).toBeVisible()
  await expect(page.getByText('100%')).toBeVisible()
  await expect(page.locator('.result-card').filter({ hasText: 'Mistakes' }).locator('dd')).toContainText('0')
})

test('restores a draft, counts retries, reveals, and resumes after save and exit', async ({ page }) => {
  await setQuestionCount(page, 2)
  await page.getByRole('button', { name: /Start practice/ }).click()

  const input = page.getByLabel('Your answer')
  await input.fill('0')
  await input.press('Enter')
  await expect(page.getByText('Not quite.', { exact: true })).toBeVisible()
  await expect(page.getByText('1', { exact: true }).last()).toBeVisible()
  await expect(input).not.toHaveAttribute('readonly', '')

  await input.fill('1234')
  await page.reload()
  await expect(page.getByText('Question 1 of 2')).toBeVisible()
  await expect(page.getByLabel('Your answer')).toHaveValue('1234')

  await page.getByRole('button', { name: 'Reveal answer' }).click()
  const revealDialog = page.getByRole('dialog', { name: 'Reveal this answer?' })
  await expect(revealDialog).toBeVisible()
  await revealDialog.getByRole('button', { name: 'Reveal answer' }).click()
  await expect(page.getByText(/Answer revealed:/)).toBeVisible()

  await page.getByRole('button', { name: 'Next question' }).click()
  await expect(page.getByText('Question 2 of 2')).toBeVisible()
  await page.getByRole('button', { name: 'Save & exit' }).click()

  await expect(page.getByRole('heading', { name: 'Continue your session' })).toBeVisible()
  await expect(page.getByText(/Question 2 of 2/)).toBeVisible()
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText('Question 2 of 2')).toBeVisible()
})

test('builds mixed questions and supports the on-screen keypad', async ({ page }) => {
  await page.locator('#minDigits').selectOption('2')
  await page.locator('#maxDigits').selectOption('3')
  await page.getByText('Subtraction', { exact: true }).click()
  await page.getByText('Multiplication', { exact: true }).click()
  await page.locator('#operator-count-3').check()
  await page.locator('#mode-mixed').check()
  await setQuestionCount(page, 1)

  await expect(page.locator('.example-card')).toContainText('2–3 digits')
  await page.getByRole('button', { name: /Start practice/ }).click()

  const operators = await page.locator('.expression__operator').allInnerTexts()
  expect(new Set(operators).size).toBeGreaterThanOrEqual(2)

  await page.getByRole('button', { name: '1', exact: true }).click()
  await page.getByRole('button', { name: '2', exact: true }).click()
  await page.getByRole('button', { name: 'Delete last digit' }).click()
  await page.getByRole('button', { name: '0', exact: true }).click()
  await expect(page.getByLabel('Your answer')).toHaveValue('10')
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByLabel('Your answer')).toHaveValue('')
})

test('has no detectable WCAG A or AA violations in core views', async ({ page }) => {
  await expectAccessible(page, 'setup')

  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start practice/ }).click()
  await expectAccessible(page, 'practice')

  const revealButton = page.getByRole('button', { name: 'Reveal answer' })
  await revealButton.click()
  await expectAccessible(page, 'reveal dialog')
  await page.keyboard.press('Escape')
  await expect(revealButton).toBeFocused()
  await revealButton.click()
  await page
    .getByRole('dialog', { name: 'Reveal this answer?' })
    .getByRole('button', { name: 'Reveal answer' })
    .click()
  await page.getByRole('button', { name: 'See results' }).click()
  await expectAccessible(page, 'completion')
})

test('has no page-level overflow at supported responsive widths', async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto(appPath)
    const dimensions = await page.evaluate(() => {
      const hero = document.querySelector<HTMLImageElement>('.hero-art')
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        heroWidth: hero?.getBoundingClientRect().width ?? 0,
        heroHeight: hero?.getBoundingClientRect().height ?? 1,
      }
    })
    expect(dimensions.scrollWidth, `${viewport.width}px layout overflowed`).toBeLessThanOrEqual(
      dimensions.clientWidth,
    )
    expect(dimensions.heroWidth / dimensions.heroHeight, `${viewport.width}px hero ratio`).toBeCloseTo(
      1600 / 560,
      1,
    )
  }
})

async function setQuestionCount(page: Page, count: number): Promise<void> {
  const input = page.locator('#problem-count')
  await input.fill(String(count))
  await input.press('Tab')
  await expect(input).toHaveValue(String(count))
}

async function expectAccessible(page: Page, view: string): Promise<void> {
  await page.waitForTimeout(200)
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
    `${view} accessibility violations`,
  ).toEqual([])
}
