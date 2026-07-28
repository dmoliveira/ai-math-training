import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const appPath = '/ai-math-training/'

test.beforeEach(async ({ page }) => {
  await page.goto(appPath)
  await page.evaluate(async () => {
    window.localStorage.clear()
    await new Promise<void>((resolve) => {
      const request = window.indexedDB.deleteDatabase('mental-math-sprint-history')
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
  })
  await page.reload()
})

test('completes an addition session entirely from the keyboard', async ({ page }) => {
  const setupHeading = page.getByRole('heading', { name: 'Sharpen your number sense.' })
  await expect(setupHeading).toBeVisible()
  await expect(setupHeading).not.toBeFocused()
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content')
  await expect(page.getByRole('navigation', { name: 'Creator links' })).toBeVisible()
  const supportLink = page.getByRole('link', { name: /Support via Stripe/ })
  await expect(supportLink).toHaveAttribute('href', 'https://buy.stripe.com/8x200i8bSgVe3Vl3g8bfO00')
  await expect(supportLink).toHaveAttribute('rel', /noopener noreferrer/)
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
  await expect(page.locator('#app-announcer')).toHaveText('Correct. See your results.')
  await expect(input).toHaveAttribute('readonly', '')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Perfect run!' })).toBeVisible()
  await expect(page.getByText('100%')).toBeVisible()
  await expect(page.locator('.result-card').filter({ hasText: 'Mistakes' }).locator('dd')).toContainText('0')
  await expect(page.getByRole('heading', { name: 'Review these questions' })).toHaveCount(0)
})

test('restores a draft, counts retries, reveals, and resumes after save and exit', async ({ page }) => {
  await setQuestionCount(page, 2)
  await page.getByRole('button', { name: /Start practice/ }).click()

  const input = page.getByLabel('Your answer')
  await input.fill('0')
  await input.press('Enter')
  await expect(page.getByText('Not quite.', { exact: true })).toBeVisible()
  await expect(page.locator('#app-announcer')).toHaveText('Incorrect. Try again.')
  await expect(page.getByText('1', { exact: true }).last()).toBeVisible()
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await expect(input).not.toHaveAttribute('readonly', '')

  await input.fill('1234')
  await expect(input).not.toHaveAttribute('aria-invalid', 'true')
  await page.reload()
  await expect(page.getByText('Question 1 of 2')).toBeVisible()
  await expect(page.getByLabel('Your answer')).toHaveValue('1234')

  await page.getByRole('button', { name: 'Reveal answer' }).click()
  const revealDialog = page.getByRole('dialog', { name: 'Reveal this answer?' })
  await expect(revealDialog).toBeVisible()
  await revealDialog.getByRole('button', { name: 'Reveal answer' }).click()
  await expect(page.locator('#answer-feedback')).toContainText('Answer revealed:')
  await expect(page.locator('#app-announcer')).toContainText('Answer revealed:')

  await page.getByRole('button', { name: 'Next question' }).click()
  await expect(page.getByText('Question 2 of 2')).toBeVisible()
  await page.getByRole('button', { name: 'Save & exit' }).click()

  await expect(page.locator('#app-announcer')).toHaveText('Session saved on this device.')
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
  await expect(page.getByLabel('Your answer')).toBeFocused()
  await page.getByRole('button', { name: '2', exact: true }).click()
  await page.getByRole('button', { name: 'Delete last digit' }).click()
  await page.getByRole('button', { name: '0', exact: true }).click()
  await expect(page.getByLabel('Your answer')).toHaveValue('10')
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByLabel('Your answer')).toHaveValue('')
})

test('persists vertical practice and scores a skipped question', async ({ page }) => {
  await page.getByLabel('Vertical').check()
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start practice/ }).click()

  await expect(page.locator('.expression--vertical')).toBeVisible()
  await expect(page.getByText(/0% complete/)).toBeVisible()
  await expect(page.getByText('This question', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skip question (+20s)' }).click()

  await expect(page.locator('#answer-feedback')).toContainText('20 seconds added')
  await expect(page.getByText(/100% complete/)).toBeVisible()
  await expect(page.locator('#app-announcer')).toContainText('Question skipped. 20 seconds added.')
  await expectAccessible(page, 'skipped question')

  await page.getByRole('button', { name: 'See results' }).click()
  await expect(page.getByRole('heading', { name: 'Session complete.' })).toBeVisible()
  await expect(page.locator('.result-card').filter({ hasText: 'Scored time' })).toContainText('00:20')
  await expect(page.getByText('Skipped (+20s)')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personal top five' })).toBeVisible()
  await expect(page.getByText('New best')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Share this result' })).toBeVisible()
  await expect(page.getByText(/For Instagram/)).toBeVisible()
  for (const name of ['X', 'Facebook', 'LinkedIn']) {
    const link = page.getByRole('link', { name: new RegExp(`^${name}`) }).last()
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener noreferrer/)
  }

  await page.getByRole('button', { name: 'Change settings' }).click()
  const historyCard = page.getByRole('heading', { name: 'Performance history' }).locator('..')
  await expect(historyCard).toContainText('Full history')
  await expect(page.getByRole('button', { name: 'Reset this history' })).toBeEnabled()
  await page.getByRole('button', { name: 'Reset this history' }).click()
  const resetDialog = page.getByRole('dialog', { name: 'Reset performance history?' })
  await resetDialog.getByRole('button', { name: 'Reset history' }).click()
  await expect(page.locator('#app-announcer')).toHaveText('Performance history reset for these settings.')
  await expect(page.getByText('No completed results yet.')).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Review these questions' })).toBeVisible()
  await expect(page.locator('.review-list li')).toHaveCount(1)
  await expectAccessible(page, 'completion')
})

test('keeps forced-color selection and focus states unambiguous', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' })

  await expect(page.locator('.operation-choice--add .operation-choice__check')).toBeVisible()
  await expect(page.locator('.operation-choice--subtract .operation-choice__check')).toBeHidden()
  await expect(page.locator('#operator-count-1 + span')).toHaveCSS('outline-style', 'solid')
  await expect(page.locator('#mode-same + .mode-card__body')).toHaveCSS('outline-style', 'solid')

  await page.locator('#operation-add').focus()
  await expect(page.locator('.operation-choice--add')).toHaveCSS('outline-style', 'solid')
})

test('keeps mobile keypad focus and restart control deliberate', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const mobile = await context.newPage()
  await mobile.goto(appPath)
  await mobile.evaluate(() => window.localStorage.clear())
  await mobile.reload()
  await setQuestionCount(mobile, 1)
  await mobile.getByRole('button', { name: /Start practice/ }).click()

  const restart = mobile.getByRole('button', { name: 'Restart session' })
  const restartBox = await restart.boundingBox()
  expect(restartBox?.width).toBeGreaterThanOrEqual(44)
  expect(restartBox?.height).toBeGreaterThanOrEqual(44)
  expect(await restart.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(
    await restart.evaluate((element) => element.clientWidth),
  )

  const digit = mobile.getByRole('button', { name: '1', exact: true })
  await digit.click()
  await expect(digit).toBeFocused()
  await expect(mobile.getByLabel('Your answer')).not.toBeFocused()
  await expect(mobile.getByLabel('Your answer')).toHaveValue('1')
  await context.close()
})

test('reviews corrected questions without expanding a perfect result', async ({ page }) => {
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start practice/ }).click()
  const input = page.getByLabel('Your answer')
  const expression = await page.locator('.expression__pieces').innerText()
  const operands = expression.match(/\d+/g)?.map(Number) ?? []

  await input.fill('0')
  await input.press('Enter')
  await input.fill(String((operands[0] ?? 0) + (operands[1] ?? 0)))
  await input.press('Enter')
  await page.getByRole('button', { name: 'See results' }).click()

  const review = page.getByRole('region', { name: 'Review these questions' })
  await expect(review).toBeVisible()
  await expect(review).toContainText('2 attempts')
  await expect(review).toContainText('=')
})

test('publishes canonical social metadata and production-base assets', async ({ page }) => {
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://dmoliveira.github.io/ai-math-training/',
  )
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://dmoliveira.github.io/ai-math-training/social-preview.png',
  )
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  )
  await expect(page.locator('script[type="module"]')).toHaveAttribute(
    'src',
    /^\/ai-math-training\/assets\//,
  )

  const socialImage = await page.request.get(`${appPath}social-preview.png`)
  expect(socialImage.ok()).toBe(true)
  expect(socialImage.headers()['content-type']).toContain('image/png')
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
