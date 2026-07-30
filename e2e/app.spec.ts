import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'

const appPath = '/mental-math-sprint/'

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

test('navigates Practice and Progress with keyboard-friendly disclosures', async ({ page }) => {
  const progress = page.getByRole('button', { name: 'Progress', exact: true })
  await progress.focus()
  await progress.press('Enter')
  await expect(page.getByRole('heading', { name: 'See what your practice is building.' })).toBeFocused()
  await expect(progress).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'No results for this setup yet' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start this setup' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset this history' })).toHaveCount(0)
  await expectAccessible(page, 'progress')

  const practice = page.getByRole('button', { name: 'Practice', exact: true })
  await practice.press('Enter')
  await expect(page.getByRole('heading', { name: 'Start a sprint in seconds.' })).toBeFocused()
  const summary = page.locator('#customize-setup > summary')
  await summary.focus()
  await summary.press('Enter')
  await expect(page.locator('#customize-setup')).toHaveJSProperty('open', true)
  const maxDigits = page.locator('#maxDigits')
  await maxDigits.selectOption('4')
  await expect(page.locator('#customize-setup')).toHaveJSProperty('open', true)
  await expect(maxDigits).toBeFocused()
})

test('completes an addition session entirely from the keyboard', async ({ page }) => {
  const setupHeading = page.getByRole('heading', { name: 'Start a sprint in seconds.' })
  await expect(setupHeading).toBeVisible()
  await expect(page.locator('.numi--pose-ready')).toHaveAttribute('src', /numi\/ready\.webp$/)
  await expect(setupHeading).not.toBeFocused()
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main-content')
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Project and creator links' })).toBeVisible()
  const supportLink = page.getByRole('link', { name: /Support via Stripe/ })
  await expect(supportLink).toHaveAttribute('href', 'https://buy.stripe.com/8x200i8bSgVe3Vl3g8bfO00')
  await expect(supportLink).toHaveAttribute('rel', /noopener noreferrer/)
  await openCustomization(page, true)
  await page.locator('#auto-advance').uncheck()
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  await expect(page.locator('.numi--pose-thinking')).toHaveAttribute('src', /numi\/thinking\.webp$/)

  const input = page.getByLabel('Your answer')
  await expect(input).toBeFocused()
  const expression = await page.locator('.expression__pieces').innerText()
  const operands = expression.match(/\d+/g)?.map(Number) ?? []
  expect(operands).toHaveLength(2)

  await input.fill(String((operands[0] ?? 0) + (operands[1] ?? 0)))
  await input.press('Enter')
  await expect(page.getByText('Correct.', { exact: true })).toBeVisible()
  await expect(page.locator('.numi--pose-celebration')).toBeVisible()
  await expect(page.locator('#app')).toHaveAttribute('data-motion', 'correct')
  expect(await page.locator('.answer-feedback').evaluate((element) => getComputedStyle(element).animationName)).toBe('feedback-arrive')
  expect(await page.locator('.progress-track span').evaluate((element) => getComputedStyle(element).animationName)).toBe('progress-earned')
  await expectAccessible(page, 'correct answer')
  await expect(page.locator('#app-announcer')).toHaveText('Correct. See your results.')
  await expect(input).toHaveAttribute('readonly', '')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Perfect run!' })).toBeVisible()
  await expect(page.locator('#app')).toHaveAttribute('data-motion', 'completion-enter')
  expect(await page.locator('.completion-card').evaluate((element) => getComputedStyle(element).animationName)).toBe('completion-fade')
  await expect(page.locator('.numi--completion.numi--pose-celebration')).toBeVisible()
  await expectAccessible(page, 'perfect completion')
  await expect(page.getByText('100%')).toBeVisible()
  await expect(page.locator('.result-card').filter({ hasText: 'Mistakes' }).locator('dd')).toContainText('0')
  await expect(page.getByRole('button', { name: /Review/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Build on this run' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Try a one-step stretch/ })).toBeVisible()
  await openCompletionMore(page)
  await expect(page.getByText('Clean set', { exact: true })).toBeVisible()
  await expect(page.getByText(/own private rankings and history/)).toBeVisible()

  await page.getByRole('button', { name: 'Change settings' }).click()
  await expect(page.getByRole('heading', { name: 'Continue this exact setup' })).toBeVisible()
  await expect(page.getByText(/100% first-try accuracy/)).toBeVisible()
  await page.getByRole('button', { name: /Start this setup/ }).click()
  await expect(page.getByLabel('Your answer')).toBeFocused()
})

test('moves to the next question automatically after correct feedback', async ({ page }) => {
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  await expect(page.locator('.auto-next-toggle')).toHaveAttribute('aria-pressed', 'true')
  const expression = await page.locator('.expression__pieces').innerText()
  const operands = expression.match(/\d+/g)?.map(Number) ?? []
  await page.getByLabel('Your answer').fill(String((operands[0] ?? 0) + (operands[1] ?? 0)))
  await page.getByLabel('Your answer').press('Enter')
  await expect(page.locator('#app-announcer')).toHaveText('Correct. Moving to the next question.')
  await expect(page.getByRole('heading', { name: 'Perfect run!' })).toBeVisible()
})

test('offers accessible one-click challenges without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  const presets = page.locator('[data-action="start-preset"]')
  await expect(presets).toHaveCount(3)
  expect(await page.locator('#setup-form').evaluate((form, preset) => Boolean(form.compareDocumentPosition(preset as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await presets.first().elementHandle())).toBe(true)
  await openCustomization(page, true)
  await expect(page.getByRole('radio', { name: /Random/ })).toBeChecked()
  await expect(page.locator('.numi--setup')).toBeHidden()
  await expect(page.getByRole('radio', { name: /Level/ })).toHaveCount(5)
  const levelFive = page.getByRole('radio', { name: /Level 5/ })
  const levelCard = await page.locator('input[name="challenge"][value="5"] + span').boundingBox()
  expect(levelCard?.height).toBeGreaterThanOrEqual(44)
  await levelFive.check()
  await expect(page.locator('.challenge-setting .selection-note')).toContainText('Level 5 starts at the approachable side')
  await expect(page.getByRole('heading', { name: 'Start with a complete challenge' })).toBeVisible()
  const quickWin = page.locator('[data-preset="quick-win"]')
  await expect(quickWin).toHaveAttribute('aria-pressed', 'false')
  const box = await quickWin.boundingBox()
  expect(box?.height).toBeGreaterThanOrEqual(44)
  await expectAccessible(page, 'guided mobile setup')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)

  await quickWin.focus()
  await expect(quickWin).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Question 1 of 5')).toBeVisible()
  await expect(page.getByLabel('Your answer')).toBeFocused()
})

test('restores a draft, counts retries, reveals, and resumes after save and exit', async ({ page }) => {
  await setQuestionCount(page, 2)
  await page.getByRole('button', { name: /Start sprint/ }).click()

  const input = page.getByLabel('Your answer')
  await input.fill('0')
  await input.press('Enter')
  await expect(page.getByText('Not quite.', { exact: true })).toBeVisible()
  await expect(page.locator('.numi--pose-encouraging')).toHaveAttribute('src', /numi\/encouraging\.webp$/)
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
  await expect(page.locator('.numi--pose-thinking')).toBeVisible()
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
  await openCustomization(page, true)
  await page.locator('#minDigits').selectOption('2')
  await page.locator('#maxDigits').selectOption('3')
  await page.getByText('Subtraction', { exact: true }).click()
  await page.getByText('Multiplication', { exact: true }).click()
  await page.locator('#operator-count-3').check()
  await page.locator('#mode-mixed').check()
  await setQuestionCount(page, 1)

  await expect(page.locator('.example-card')).toContainText('2–3 digits')
  await page.getByRole('button', { name: /Start sprint/ }).click()

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
  await page.setViewportSize({ width: 390, height: 844 })
  await openCustomization(page, true)
  await page.getByLabel('Vertical').check()
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()

  await expect(page.locator('.expression--vertical')).toBeVisible()
  await expect(page.getByText(/0% complete/)).toBeVisible()
  await expect(page.getByText('This question', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Skip question (+20s)' }).click()

  await expect(page.locator('#answer-feedback')).toContainText('20 seconds added')
  await expect(page.locator('.numi--pose-encouraging')).toBeVisible()
  await expect(page.locator('.mascot-coach--skipped')).toBeVisible()
  await expect(page.getByText(/100% complete/)).toBeVisible()
  await expect(page.locator('#app-announcer')).toContainText('Question skipped. 20 seconds added.')
  await expectAccessible(page, 'skipped question')

  await page.getByRole('button', { name: 'See results' }).click()
  await expect(page.getByRole('heading', { name: 'Session complete.' })).toBeVisible()
  await expect(page.locator('.numi--completion')).toBeVisible()
  await expect(page.locator('.result-card').filter({ hasText: 'Scored time' })).toContainText('00:20')
  const primaryAction = page.locator('.completion-next__primary .button')
  const primaryBox = await primaryAction.boundingBox()
  expect((primaryBox?.y ?? 844) + (primaryBox?.height ?? 1)).toBeLessThanOrEqual(844)
  expect(primaryBox?.height).toBeGreaterThanOrEqual(44)
  await expectAccessible(page, 'collapsed mobile completion')
  await openCompletionMore(page)
  await expect(page.getByText('Skipped · +20s', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personal top five' })).toBeVisible()
  await expect(page.getByText('New best')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Share this result' })).toBeVisible()
  await expect(page.getByText(/For Instagram/)).toBeVisible()
  for (const name of ['X', 'Facebook', 'LinkedIn']) {
    const link = page.getByRole('link', { name: new RegExp(`^${name}`) }).last()
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener noreferrer/)
  }

  await page.getByRole('button', { name: 'View progress' }).click()
  await expect(page.getByRole('heading', { name: 'See what your practice is building.' })).toBeFocused()
  const historyCard = page.getByRole('heading', { name: 'Performance history' }).locator('..')
  await expect(page.getByRole('heading', { name: 'Your baseline is ready' })).toBeVisible()
  await expect(page.locator('.progress-snapshot')).toContainText('Latest first-try accuracy')
  await expect(page.locator('.history-list time')).toHaveAttribute('datetime', /T/)
  await expect(historyCard).toContainText('Full history')
  await expect(page.getByRole('button', { name: 'Reset this history' })).toBeEnabled()
  await page.getByRole('button', { name: 'Reset this history' }).click()
  const resetDialog = page.getByRole('dialog', { name: 'Reset performance history?' })
  await resetDialog.getByRole('button', { name: 'Reset history' }).click()
  await expect(page.locator('#app-announcer')).toHaveText('Performance history reset for these settings.')
  await expect(resetDialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'No results for this setup yet' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No results for this setup yet' })).toBeFocused()
})

test('retries the exact difficult set in a resumable unscored mastery review', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await setQuestionCount(page, 3)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  const sourceExpressions: string[] = []

  const first = await currentAddition(page)
  sourceExpressions.push(first.label)
  await page.getByLabel('Your answer').fill(String(first.answer + 1))
  await page.getByLabel('Your answer').press('Enter')
  await page.getByLabel('Your answer').fill(String(first.answer))
  await page.getByLabel('Your answer').press('Enter')
  await page.getByRole('button', { name: 'Next question' }).click()

  sourceExpressions.push((await currentAddition(page)).label)
  await page.getByRole('button', { name: 'Skip question (+20s)' }).click()
  await page.getByRole('button', { name: 'Next question' }).click()

  sourceExpressions.push((await currentAddition(page)).label)
  await page.getByRole('button', { name: 'Reveal answer' }).click()
  await page.getByRole('dialog', { name: 'Reveal this answer?' }).getByRole('button', { name: 'Reveal answer' }).click()
  await page.getByRole('button', { name: 'See results' }).click()

  await expect(page.getByRole('button', { name: /Review these 3 questions/ })).toBeVisible()
  await openCompletionMore(page)
  await expect(page.getByRole('heading', { name: 'Focus on 3 questions' })).toBeVisible()
  await page.getByText('Question breakdown (3)').click()
  await expect(page.locator('.question-breakdown li')).toHaveCount(3)
  await expect(page.getByText(/Exact setup/)).toHaveCount(0)
  expect(await indexedResultCount(page)).toBe(1)

  await page.getByRole('button', { name: /Review these 3 questions/ }).click()
  await expect(page.getByText(/Mistake-to-mastery review/)).toBeVisible()
  await expect(page.locator('.numi--pose-thinking')).toBeVisible()
  await expect(page.locator('.mascot-coach p')).toContainText('We’ve seen this one before')
  await expect(page.locator('.support-card')).toBeHidden()
  await expect(page.locator('.expression')).toHaveAttribute('aria-label', sourceExpressions[0]!)
  await expect(page.getByRole('button', { name: 'Skip question' })).toBeVisible()
  await expectAccessible(page, 'review practice')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)

  await page.getByRole('button', { name: 'Skip question' }).click()
  await expect(page.locator('#answer-feedback')).toContainText('Keep it in your next review round')
  await expect(page.locator('.numi--pose-encouraging')).toBeVisible()
  await page.getByRole('button', { name: 'Save & exit' }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Continue your review' })).toBeVisible()
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.locator('.expression')).toHaveAttribute('aria-label', sourceExpressions[0]!)
  await page.getByRole('button', { name: 'Next question' }).click()

  for (let index = 1; index < sourceExpressions.length; index += 1) {
    await expect(page.locator('.expression')).toHaveAttribute('aria-label', sourceExpressions[index]!)
    await page.getByRole('button', { name: 'Skip question' }).click()
    await page.getByRole('button', { name: index === sourceExpressions.length - 1 ? 'Finish review' : 'Next question' }).click()
  }

  await expect(page.getByRole('heading', { name: 'Review complete.' })).toBeVisible()
  await expect(page.locator('.numi--completion.numi--pose-encouraging')).toBeVisible()
  await expect(page.getByText('Unscored mastery round')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personal top five' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Share this result' })).toHaveCount(0)
  await expect(page.getByText(/never affect rankings or history/)).toBeVisible()
  await expectAccessible(page, 'review completion')
  expect(await indexedResultCount(page)).toBe(1)

  await page.getByRole('button', { name: 'View progress' }).click()
  await expect(page.locator('.progress-context')).toContainText('Showing exact setup')
  await expect(page.locator('.progress-context')).toContainText('3 questions')
})

test('has no detectable WCAG A or AA violations in core views', async ({ page }) => {
  await expectAccessible(page, 'setup')
  await openCustomization(page, true)
  await expectAccessible(page, 'expanded setup')

  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  await expectAccessible(page, 'practice')

  await page.getByLabel('Your answer').fill('0')
  await page.getByLabel('Your answer').press('Enter')
  await expect(page.locator('.numi--pose-encouraging')).toBeVisible()
  await expectAccessible(page, 'incorrect answer')

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
  await expect(page.getByRole('button', { name: 'Review this question' })).toBeVisible()
  await expectAccessible(page, 'completion')
  await openCompletionMore(page)
  await expect(page.getByRole('heading', { name: 'Focus on 1 question' })).toBeVisible()
  await expectAccessible(page, 'expanded completion')
})

test('starts and resumes unscored focus practice from exact private history', async ({ page }) => {
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  await page.getByRole('button', { name: 'Skip question (+20s)' }).click()
  await page.getByRole('button', { name: 'See results' }).click()
  await expect(page.getByRole('button', { name: 'Review this question' })).toBeVisible()
  await page.getByRole('button', { name: 'View progress' }).click()
  const pastPractice = page.getByRole('button', { name: 'Practice past focus questions' })
  await expect(pastPractice).toBeVisible()
  await pastPractice.click()
  await expect(page.getByText(/Mistake-to-mastery review/)).toBeVisible()
  await expect(page.locator('#app-announcer')).toContainText('Private focus review started')
  expect(await indexedResultCount(page)).toBe(1)
  await page.getByRole('button', { name: 'Save & exit' }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Continue your review' })).toBeVisible()
})

test('keeps forced-color selection and focus states unambiguous', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' })
  await expect(page.getByRole('heading', { name: 'Start a sprint in seconds.' })).toBeVisible()
  await openCustomization(page, true)

  await expect(page.locator('.operation-choice--add .operation-choice__check')).toBeVisible()
  await expect(page.locator('.operation-choice--subtract .operation-choice__check')).toBeHidden()
  await expect(page.locator('#operator-count-1 + span')).toHaveCSS('outline-style', 'solid')
  await expect(page.locator('#mode-same + .mode-card__body')).toHaveCSS('outline-style', 'solid')
  await expect(page.locator('input[name="challenge"][value="random"] + span')).toHaveCSS('outline-style', 'solid')
  await page.locator('[data-preset="quick-win"]').focus()
  await expect(page.locator('[data-preset="quick-win"]')).toHaveCSS('outline-style', 'solid')

  await page.locator('#operation-add').focus()
  await expect(page.locator('.operation-choice--add')).toHaveCSS('outline-style', 'solid')

  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  await expect(page.locator('.auto-next-toggle')).toHaveCSS('outline-style', 'solid')
  await expect(page.locator('.mascot-coach p')).toContainText('Numi')
  await expect(page.locator('.numi--coach')).toBeHidden()
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
  await mobile.getByRole('button', { name: /Start sprint/ }).click()
  await mobile.getByRole('button', { name: /Timers Shown/ }).click()
  await expect(mobile.locator('#elapsed-time')).toHaveText('Hidden')
  await expect(mobile.locator('#question-time')).toHaveText('Hidden')
  await expect(mobile.locator('.timer-visibility-toggle')).toBeFocused()

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
  await page.getByRole('button', { name: /Start sprint/ }).click()
  const input = page.getByLabel('Your answer')
  const expression = await page.locator('.expression__pieces').innerText()
  const operands = expression.match(/\d+/g)?.map(Number) ?? []

  await input.fill('0')
  await input.press('Enter')
  await input.fill(String((operands[0] ?? 0) + (operands[1] ?? 0)))
  await input.press('Enter')
  await page.getByRole('button', { name: 'See results' }).click()

  await openCompletionMore(page)
  const debrief = page.getByRole('region', { name: 'Focus on 1 question' })
  await expect(debrief).toBeVisible()
  await expect(debrief).toContainText('Correct after 1 retry')
  const disclosure = page.getByText('Question breakdown (1)')
  await disclosure.focus()
  await disclosure.press('Enter')
  await expect(page.locator('.question-breakdown li')).toHaveCount(1)
  await expect(disclosure).toBeFocused()
  await page.getByRole('button', { name: 'Sprint again' }).click()
  await expect(page.getByText('Question 1 of 1')).toBeVisible()
})

test('persists themes and compact mode with accessible icon navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  const bio = page.getByRole('link', { name: /^Bio/ })
  await expect(bio).toBeVisible()
  await page.getByLabel('Appearance settings').click()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Appearance settings')).toBeFocused()
  await expect(page.locator('.appearance-menu')).not.toHaveAttribute('open', '')
  await page.getByLabel('Appearance settings').click()
  await page.getByRole('heading', { name: 'Start a sprint in seconds.' }).click()
  await expect(page.locator('.appearance-menu')).not.toHaveAttribute('open', '')
  await page.getByLabel('Appearance settings').click()
  await page.getByRole('button', { name: /Midnight theme/ }).click()
  await expect(page.getByLabel('Appearance settings')).toBeFocused()
  await page.getByLabel('Appearance settings').click()
  await page.getByRole('button', { name: /Compact layout/ }).click()
  await expect(page.getByLabel('Appearance settings')).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  await expectAccessible(page, 'midnight compact setup')
  const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  await setQuestionCount(page, 1)
  await page.getByRole('button', { name: /Start sprint/ }).click()
  await expect(page.locator('.mascot-coach')).toBeVisible()
  await expect(page.locator('.support-card')).toBeHidden()
  const compactKey = await page.getByRole('button', { name: '1', exact: true }).boundingBox()
  expect(compactKey?.width).toBeGreaterThanOrEqual(44)
  expect(compactKey?.height).toBeGreaterThanOrEqual(44)
  await expectAccessible(page, 'midnight compact practice')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const animation = await page.locator('.numi--coach').evaluate((element) => getComputedStyle(element).animationName)
  expect(animation).toBe('none')
  await page.getByLabel('Your answer').fill('0')
  await page.getByLabel('Your answer').press('Enter')
  expect(await page.locator('.answer-feedback').evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  expect(await page.locator('.progress-track span').evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
})

test('publishes canonical social metadata and production-base assets', async ({ page }) => {
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://dmoliveira.github.io/mental-math-sprint/',
  )
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://dmoliveira.github.io/mental-math-sprint/social-preview.png',
  )
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  )
  await expect(page.locator('script[type="module"]')).toHaveAttribute(
    'src',
    /^\/mental-math-sprint\/assets\//,
  )

  const socialImage = await page.request.get(`${appPath}social-preview.png`)
  expect(socialImage.ok()).toBe(true)
  expect(socialImage.headers()['content-type']).toContain('image/png')
  const orbit = await page.request.get(`${appPath}sprint-orbit.svg`)
  expect(orbit.ok()).toBe(true)
  expect(orbit.headers()['content-type']).toContain('image/svg+xml')
  let mascotBytes = 0
  for (const asset of ['ready', 'thinking', 'encouraging', 'celebration']) {
    const response = await page.request.get(`${appPath}numi/${asset}.webp`)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('image/webp')
    mascotBytes += (await response.body()).byteLength
  }
  expect(mascotBytes).toBeLessThanOrEqual(70 * 1_024)
  expect(existsSync('public/numi-mascot.svg')).toBe(false)

  const mascotIntegrity = await page.evaluate(async (base) => {
    const poses = ['ready', 'thinking', 'encouraging', 'celebration']
    return Promise.all(poses.map(async (pose) => {
      const image = await createImageBitmap(await (await fetch(`${base}numi/${pose}.webp`)).blob())
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const corners: Array<[number, number]> = [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]
      return { pose, width: image.width, height: image.height, cornerAlpha: corners.map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]) }
    }))
  }, appPath)
  for (const asset of mascotIntegrity) {
    expect(asset.width).toBe(512)
    expect(asset.height).toBe(512)
    expect(asset.cornerAlpha).toEqual([0, 0, 0, 0])
  }
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
      const header = document.querySelector<HTMLElement>('.site-header__inner')
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        headerHeight: header?.getBoundingClientRect().height ?? 0,
      }
    })
    expect(dimensions.scrollWidth, `${viewport.width}px layout overflowed`).toBeLessThanOrEqual(
      dimensions.clientWidth,
    )
    expect(dimensions.headerHeight, `${viewport.width}px header wrapped`).toBeLessThanOrEqual(74)
  }
})

async function setQuestionCount(page: Page, count: number): Promise<void> {
  await openCustomization(page)
  const input = page.locator('#problem-count')
  await input.fill(String(count))
  await input.press('Tab')
  await expect(input).toHaveValue(String(count))
}

async function openCustomization(page: Page, advanced = false): Promise<void> {
  const customize = page.locator('#customize-setup')
  if (!(await customize.evaluate((element) => (element as HTMLDetailsElement).open))) await customize.locator(':scope > summary').click()
  if (advanced) {
    const more = page.locator('#advanced-setup')
    if (!(await more.evaluate((element) => (element as HTMLDetailsElement).open))) await more.locator(':scope > summary').click()
  }
}

async function openCompletionMore(page: Page): Promise<void> {
  const details = page.locator('.completion-more')
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) await details.locator(':scope > summary').click()
  await expect(details).toHaveJSProperty('open', true)
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

async function currentAddition(page: Page): Promise<{ label: string; answer: number }> {
  const expression = page.locator('.expression')
  const label = await expression.getAttribute('aria-label')
  const operands = (await expression.innerText()).match(/\d+/g)?.map(Number) ?? []
  expect(label).not.toBeNull()
  expect(operands).toHaveLength(2)
  return { label: label!, answer: operands[0]! + operands[1]! }
}

async function indexedResultCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mental-math-sprint-history')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database.transaction('results', 'readonly').objectStore('results').count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    } finally {
      database.close()
    }
  })
}
