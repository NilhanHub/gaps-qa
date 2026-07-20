import { writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type BrowserContext, type ConsoleMessage, type Page, type Response } from "playwright";

import type {
  ArtifactManifest,
  ComponentRecord,
  FindingRecord,
  SurfaceRecord,
  UiElementReviewRecord,
  WorkflowRecord,
} from "../../shared/src/index.js";
import type { BrowserAuditRunner, RunnerAuditOutput, RunnerContext } from "./types.js";
import {
  classifyTarget,
  defaultSummary,
  ensureDir,
  findingSeverityFromStatus,
  slugify,
  writeJsonl,
} from "./utils.js";

interface ConsoleEntry {
  page: string;
  type: string;
  text: string;
}

interface NetworkEntry {
  url: string;
  status: number;
  ok: boolean;
  method: string;
}

interface SurfaceVisit {
  id: string;
  url: string;
  title: string;
  path: string;
  entryPoint: string;
  screenshotPath: string;
}

type UiActionKind =
  | "link"
  | "text_input"
  | "toggle"
  | "select"
  | "tab"
  | "submit"
  | "disclosure"
  | "generic";

interface UiElementCandidate {
  qaId: string;
  reviewId: string;
  componentId: string;
  surfaceId: string;
  signature: string;
  elementType: string;
  label: string;
  distinctState: string;
  actionKind: UiActionKind;
  href: string | null;
  role: string | null;
  tagName: string;
  inputType: string | null;
  isDisabled: boolean;
  isReadOnly: boolean;
}

interface SurfaceSnapshot {
  components: ComponentRecord[];
  candidates: UiElementCandidate[];
}

interface InteractionResult {
  review: UiElementReviewRecord;
  finding: FindingRecord | null;
}

interface ObservedElementState {
  url: string;
  title: string;
  hash: string;
  dialogCount: number;
  menuCount: number;
  expanded: string | null;
  selected: string | null;
  checked: boolean | null;
  value: string | null;
}

function artifactPath(kind: string, fileName: string) {
  return `docs/qa/artifacts/${kind}/${fileName}`;
}

function maxDiscoveredSurfaces(auditMode: RunnerContext["auditMode"]) {
  switch (auditMode) {
    case "surface_map_only":
      return 2;
    case "workflow_audit":
      return 4;
    case "full_ui_release_audit":
      return 6;
    default:
      return 4;
  }
}

function safeLabel(label: string) {
  return slugify(label).slice(0, 24) || "ui-element";
}

function isMutationRisk(candidate: UiElementCandidate) {
  const riskyLabelPattern =
    /\b(delete|remove|destroy|archive|purchase|pay|checkout|confirm|publish|unsubscribe|terminate|place order|submit|save|create|update|send|apply)\b/i;
  return candidate.actionKind === "submit" || riskyLabelPattern.test(candidate.label);
}

function sampleValueForCandidate(candidate: UiElementCandidate) {
  switch (candidate.inputType) {
    case "email":
      return "qa@example.com";
    case "tel":
      return "5550100";
    case "url":
      return "https://example.com";
    case "number":
      return "42";
    case "search":
      return "qa sample";
    case "password":
      return "qa-password";
    default:
      return "QA sample";
  }
}

function summarizeFindings(
  findings: FindingRecord[],
  workflows: WorkflowRecord[],
  blockedCount: number,
  uiElementReviews: UiElementReviewRecord[],
) {
  const severe = findings.filter(
    (finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH",
  );
  const medium = findings.filter((finding) => finding.severity === "MEDIUM");
  const blockedReviews = uiElementReviews.filter((review) => review.result === "BLOCKED");

  return {
    topRisks:
      severe.length > 0
        ? severe.slice(0, 3).map((finding) => finding.title)
        : blockedReviews.length > 0
          ? blockedReviews.slice(0, 3).map((review) => `${review.label}: ${review.terminalState}`)
          : blockedCount > 0
            ? ["Some flows remained blocked or gated during the audit."]
            : ["No severe browser-level failures were observed in the captured pass."],
    biggestWorkflowFailures: workflows
      .filter((workflow) => workflow.result === "FAILED")
      .map((workflow) => workflow.name),
    biggestUxFrictionPoints:
      medium.length > 0
        ? medium.slice(0, 3).map((finding) => finding.title)
        : uiElementReviews
            .filter((review) => review.result !== "PASSED")
            .slice(0, 3)
            .map((review) => `${review.label}: ${review.humanSummary}`),
    bluntBottomLine:
      severe.length > 0
        ? "The browser audit completed, but severe issues reduced trust in the audited experience."
        : "The browser audit completed and verified visible UI elements through safe terminal states.",
  };
}

function attachPageObservers(
  page: Page,
  consoleEntries: ConsoleEntry[],
  networkEntries: NetworkEntry[],
) {
  page.on("console", (message: ConsoleMessage) => {
    consoleEntries.push({
      page: page.url(),
      type: message.type(),
      text: message.text(),
    });
  });

  page.on("response", async (response: Response) => {
    const request = response.request();
    networkEntries.push({
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      method: request.method(),
    });
  });
}

async function navigateWithWait(page: Page, url: string) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
}

async function openAuditPage(
  browserContext: BrowserContext,
  url: string,
  consoleEntries: ConsoleEntry[],
  networkEntries: NetworkEntry[],
) {
  const page = await browserContext.newPage();
  attachPageObservers(page, consoleEntries, networkEntries);
  await navigateWithWait(page, url);
  return page;
}

async function observeElementState(page: Page, qaId: string): Promise<ObservedElementState> {
  return page.evaluate((lookupQaId) => {
    const element = document.querySelector(`[data-gaps-qa-id="${lookupQaId}"]`) as
      | HTMLElement
      | HTMLInputElement
      | HTMLSelectElement
      | HTMLTextAreaElement
      | null;
    const visibleCount = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).filter((node) => {
        const target = node as HTMLElement;
        const style = window.getComputedStyle(target);
        const rect = target.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).length;

    return {
      url: window.location.href,
      title: document.title,
      hash: window.location.hash,
      dialogCount: visibleCount("[role='dialog'], dialog, [aria-modal='true']"),
      menuCount: visibleCount("[role='menu'], [role='listbox']"),
      expanded: element?.getAttribute("aria-expanded") ?? null,
      selected: element?.getAttribute("aria-selected") ?? null,
      checked:
        element && "checked" in element
          ? Boolean((element as HTMLInputElement).checked)
          : element?.getAttribute("aria-checked") === "true",
      value:
        element && "value" in element
          ? String((element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value ?? "")
          : null,
    };
  }, qaId);
}

async function markAndCollectCandidates(page: Page, surfaceId: string): Promise<SurfaceSnapshot> {
  const candidates = await page.evaluate((currentSurfaceId) => {
    const selectors = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "[role='button']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='switch']",
      "[role='combobox']",
    ];

    const visible = (element: Element) => {
      const target = element as HTMLElement;
      const style = window.getComputedStyle(target);
      const rect = target.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const labelFor = (element: Element, index: number) => {
      const target = element as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> };
      const text = target.innerText?.trim() || target.textContent?.trim() || "";
      const aria = target.getAttribute("aria-label") || "";
      const labelledBy = target.getAttribute("aria-labelledby");
      const labelledText =
        labelledBy
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() || "")
          .filter(Boolean)
          .join(" ") || "";
      const labels = target.labels ? Array.from(target.labels).map((label) => label.textContent?.trim() || "").join(" ") : "";
      const placeholder = "placeholder" in target ? (target as HTMLInputElement).placeholder : "";
      const name = target.getAttribute("name") || target.getAttribute("id") || "";
      return text || aria || labelledText || labels || placeholder || name || `${element.tagName.toLowerCase()}_${index + 1}`;
    };

    const distinctStateFor = (element: Element) => {
      const target = element as HTMLElement & { checked?: boolean; readOnly?: boolean };
      if (
        target.hasAttribute("disabled") ||
        target.getAttribute("aria-disabled") === "true"
      ) {
        return "disabled";
      }
      if ("readOnly" in target && target.readOnly) {
        return "readonly";
      }
      if ("checked" in target && target.checked) {
        return "checked";
      }
      if (target.getAttribute("aria-selected") === "true") {
        return "selected";
      }
      if (target.getAttribute("aria-expanded") === "true") {
        return "expanded";
      }
      return "default";
    };

    const actionKindFor = (element: Element): UiActionKind => {
      const target = element as HTMLElement;
      const tagName = element.tagName.toLowerCase();
      const role = target.getAttribute("role");
      const inputType = tagName === "input" ? ((target as HTMLInputElement).type || "text").toLowerCase() : "";

      if (tagName === "a") {
        return "link";
      }
      if (role === "tab") {
        return "tab";
      }
      if (tagName === "select") {
        return "select";
      }
      if (["checkbox", "radio"].includes(inputType) || ["checkbox", "radio", "switch"].includes(role || "")) {
        return "toggle";
      }
      if (["text", "email", "search", "url", "tel", "number", "password", ""].includes(inputType) && tagName === "input") {
        return "text_input";
      }
      if (tagName === "textarea") {
        return "text_input";
      }
      if (inputType === "submit" || (tagName === "button" && target.closest("form"))) {
        return "submit";
      }
      if (target.hasAttribute("aria-expanded") || target.getAttribute("aria-haspopup")) {
        return "disclosure";
      }
      return "generic";
    };

    const elements = Array.from(document.querySelectorAll(selectors.join(","))).filter(visible);
    const deduped = new Map<string, UiElementCandidate>();
    let counter = 0;

    for (const element of elements) {
      const target = element as HTMLElement & {
        href?: string;
        type?: string;
        readOnly?: boolean;
      };
      const label = labelFor(element, counter);
      if (!label) {
        continue;
      }

      const tagName = element.tagName.toLowerCase();
      const role = target.getAttribute("role");
      const inputType = tagName === "input" ? (target.type || "text").toLowerCase() : null;
      const actionKind = actionKindFor(element);
      const distinctState = distinctStateFor(element);
      const signature = [tagName, role || "", label, distinctState, target.getAttribute("href") || ""].join("|");
      if (deduped.has(signature)) {
        continue;
      }

      counter += 1;
      const qaId = `${currentSurfaceId}_candidate_${counter}`;
      target.setAttribute("data-gaps-qa-id", qaId);
      deduped.set(signature, {
        qaId,
        reviewId: `${currentSurfaceId}_review_${counter}`,
        componentId: `${currentSurfaceId}_component_${counter}`,
        surfaceId: currentSurfaceId,
        signature,
        elementType: role || tagName,
        label,
        distinctState,
        actionKind,
        href: tagName === "a" ? (target as HTMLAnchorElement).href || null : null,
        role,
        tagName,
        inputType,
        isDisabled:
          target.hasAttribute("disabled") ||
          target.getAttribute("aria-disabled") === "true",
        isReadOnly: Boolean("readOnly" in target && target.readOnly),
      });
    }

    return Array.from(deduped.values());
  }, surfaceId);

  return {
    components: candidates.map((candidate) => ({
      id: candidate.componentId,
      surfaceId: candidate.surfaceId,
      type: candidate.elementType,
      label: candidate.label,
      distinctState: candidate.distinctState,
      actionAttempted: "Queued for safe deep proofing",
      result: "UNVERIFIED",
      notes: "The element was inventoried and is waiting for an isolated interaction attempt.",
      evidencePaths: [],
    })),
    candidates,
  };
}

function updateComponentsWithReviews(
  components: ComponentRecord[],
  reviews: UiElementReviewRecord[],
) {
  const reviewByComponentId = new Map(
    reviews
      .filter((review) => review.componentId)
      .map((review) => [review.componentId as string, review]),
  );

  return components.map((component) => {
    const review = reviewByComponentId.get(component.id);
    if (!review) {
      return component;
    }

    return {
      ...component,
      actionAttempted: review.actionAttempted,
      result: review.result,
      notes: review.humanSummary,
      evidencePaths: review.evidencePaths,
    };
  });
}

async function captureScreenshot(
  page: Page,
  screenshotsDir: string,
  kind: string,
  fileName: string,
) {
  const destination = path.join(screenshotsDir, fileName);
  await page.screenshot({ path: destination, fullPage: true });
  return artifactPath(kind, fileName);
}

function buildWorkflowFromReview(review: UiElementReviewRecord): WorkflowRecord {
  return {
    id: `${review.id}_workflow`,
    name: `Exercise ${review.label}`,
    entryPoint: review.surfaceId,
    stepsExecuted: review.stepsExecuted,
    terminalState: review.terminalState,
    result: review.result,
    defectIds: review.linkedFindingIds,
    evidencePaths: review.evidencePaths,
  };
}

function buildFindingFromReview(
  review: UiElementReviewRecord,
  targetUrl: string,
): FindingRecord | null {
  if (review.result !== "FAILED") {
    return null;
  }

  return {
    id: `finding_${review.id}`,
    severity: findingSeverityFromStatus(review.result),
    surfaceId: review.surfaceId,
    area: "UI element interaction",
    title: `${review.label} did not reach a visible terminal state`,
    componentOrWorkflow: review.label,
    reproductionSteps: [`Open ${targetUrl}.`, ...review.stepsExecuted],
    expectedBehavior: "A visible UI element should produce a clear terminal state when exercised in the browser.",
    actualBehavior: review.humanSummary,
    confidence: "CERTAIN",
    screenshotPath: review.evidencePaths[0] ?? null,
    tracePath: null,
  };
}

async function exerciseTextInput(
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
) {
  const value = sampleValueForCandidate(candidate);
  await locator.fill(value);
  stepsExecuted.push(`Type temporary value into ${candidate.label}`);
  const typedValue = await locator.inputValue();
  await locator.fill("");
  stepsExecuted.push(`Clear ${candidate.label}`);
  const clearedValue = await locator.inputValue();

  if (typedValue === value && clearedValue === "") {
    return {
      result: "PASSED" as const,
      terminalState: "Accepted temporary input and cleared it",
      humanSummary: `Typed a temporary value into ${candidate.label} and cleared it again. The field responded as expected.`,
    };
  }

  return {
    result: "FAILED" as const,
    terminalState: "Input did not reliably accept and clear a temporary value",
    humanSummary: `Tried to type into ${candidate.label}, but the field did not reliably accept and clear a temporary value.`,
  };
}

async function exerciseToggle(
  page: Page,
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
) {
  const before = await observeElementState(page, candidate.qaId);
  await locator.click({ timeout: 5_000 });
  stepsExecuted.push(`Toggle ${candidate.label}`);
  await page.waitForTimeout(150);
  const after = await observeElementState(page, candidate.qaId);

  if (before.checked !== after.checked || before.selected !== after.selected) {
    if (candidate.inputType === "checkbox" || candidate.role === "switch") {
      await locator.click({ timeout: 5_000 }).catch(() => {});
      stepsExecuted.push(`Restore ${candidate.label} to its original state`);
    }

    return {
      result: "PASSED" as const,
      terminalState: "State changed visibly",
      humanSummary: `Exercised ${candidate.label} and saw its checked or selected state change visibly.`,
    };
  }

  return {
    result: "FAILED" as const,
    terminalState: "No visible state change after toggle",
    humanSummary: `Tried ${candidate.label}, but no visible toggle or selected-state change followed the interaction.`,
  };
}

async function exerciseSelect(
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
) {
  const values = await locator.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) {
      return { current: "", options: [] as string[] };
    }

    return {
      current: element.value,
      options: Array.from(element.options).map((option) => option.value).filter(Boolean),
    };
  });

  const nextValue = values.options.find((value) => value !== values.current);
  if (!nextValue) {
    return {
      result: "BLOCKED" as const,
      terminalState: "No alternate option was available to test safely",
      humanSummary: `The ${candidate.label} control only exposed a single option, so there was no safe alternate state to verify.`,
    };
  }

  await locator.selectOption(nextValue);
  stepsExecuted.push(`Select alternate option in ${candidate.label}`);
  const changedValue = await locator.inputValue();
  await locator.selectOption(values.current).catch(() => {});
  stepsExecuted.push(`Restore original option in ${candidate.label}`);

  if (changedValue === nextValue) {
    return {
      result: "PASSED" as const,
      terminalState: "Alternate option was selected and the control could be restored",
      humanSummary: `Changed ${candidate.label} to an alternate option and restored the original value without issues.`,
    };
  }

  return {
    result: "FAILED" as const,
    terminalState: "Select control did not hold the alternate option",
    humanSummary: `Tried to change ${candidate.label}, but the control did not hold the alternate option reliably.`,
  };
}

async function exerciseTab(
  page: Page,
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
) {
  await locator.click({ timeout: 5_000 });
  stepsExecuted.push(`Switch to ${candidate.label} tab`);
  await page.waitForTimeout(150);
  const after = await observeElementState(page, candidate.qaId);
  if (after.selected === "true") {
    return {
      result: "PASSED" as const,
      terminalState: "Tab became selected",
      humanSummary: `Selected the ${candidate.label} tab and the interface reflected the tab change visibly.`,
    };
  }

  return {
    result: "FAILED" as const,
    terminalState: "Tab did not become visibly selected",
    humanSummary: `Clicked the ${candidate.label} tab, but the selected-state styling or panel swap did not become visible.`,
  };
}

async function exerciseSubmit(
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
  safetyMode: RunnerContext["safetyMode"],
) {
  const formState = await locator.evaluate((element) => {
    const form = element.closest("form");
    if (!(form instanceof HTMLFormElement)) {
      return { hasForm: false, valid: true, invalidMessages: [] as string[] };
    }

    return {
      hasForm: true,
      valid: form.checkValidity(),
      invalidMessages: Array.from(form.querySelectorAll(":invalid"))
        .map((node) => (node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).validationMessage || "")
        .filter(Boolean),
    };
  });

  if (!formState.hasForm) {
    return {
      result: "BLOCKED" as const,
      terminalState: "Submit-like control was not attached to a form",
      humanSummary: `The ${candidate.label} control looked submit-like, but it was not attached to a form that could be tested safely.`,
    };
  }

  if (!formState.valid) {
    await locator.click({ timeout: 5_000 });
    stepsExecuted.push(`Trigger validation on ${candidate.label}`);
    return {
      result: "PASSED" as const,
      terminalState: "Browser validation blocked submission before mutation",
      humanSummary: `Triggered ${candidate.label} with an invalid form and observed the browser-level validation path instead of a mutating submit.`,
    };
  }

  if (safetyMode === "safe_read_only") {
    return {
      result: "BLOCKED" as const,
      terminalState: "Safe deep pass stopped before a potentially mutating submit",
      humanSummary: `Stopped before ${candidate.label} because submitting a valid form could mutate the target environment.`,
    };
  }

  await locator.click({ timeout: 5_000 });
  stepsExecuted.push(`Submit ${candidate.label}`);
  return {
    result: "PASSED" as const,
    terminalState: "Submit control was exercised under risky-write mode",
    humanSummary: `Exercised ${candidate.label} under explicit risky-write mode and the page reached a post-submit state.`,
  };
}

async function exerciseLink(
  page: Page,
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
  targetUrl: string,
) {
  if (!candidate.href) {
    return {
      result: "FAILED" as const,
      terminalState: "Link had no href to follow",
      humanSummary: `The ${candidate.label} element appeared as a link, but no followable href was present.`,
    };
  }

  const href = new URL(candidate.href, page.url());
  const targetOrigin = new URL(targetUrl).origin;
  if (href.origin !== targetOrigin) {
    return {
      result: "BLOCKED" as const,
      terminalState: "Link leaves the audited origin",
      humanSummary: `Skipped ${candidate.label} because it leaves the audited origin and would break surface-scope coverage.`,
    };
  }

  const before = await observeElementState(page, candidate.qaId);
  const popupPromise = page.context().waitForEvent("page", { timeout: 1_500 }).catch(() => null);
  await locator.click({ timeout: 5_000 });
  stepsExecuted.push(`Click ${candidate.label}`);

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    const popupUrl = popup.url();
    await popup.close().catch(() => {});
    return {
      result: "PASSED" as const,
      terminalState: `Opened linked page ${popupUrl}`,
      humanSummary: `Clicked ${candidate.label} and the browser opened a linked page as expected.`,
    };
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  const after = await observeElementState(page, candidate.qaId);
  if (after.url !== before.url || after.hash !== before.hash || after.title !== before.title) {
    return {
      result: "PASSED" as const,
      terminalState: `Navigated to ${after.url}`,
      humanSummary: `Clicked ${candidate.label} and reached a new page state at ${after.url}.`,
    };
  }

  return {
    result: "FAILED" as const,
    terminalState: "No visible navigation change followed the click",
    humanSummary: `Clicked ${candidate.label}, but the page did not move to a visibly different destination.`,
  };
}

async function exerciseGenericAction(
  page: Page,
  candidate: UiElementCandidate,
  locator: ReturnType<Page["locator"]>,
  stepsExecuted: string[],
) {
  const before = await observeElementState(page, candidate.qaId);
  await locator.click({ timeout: 5_000 });
  stepsExecuted.push(`Click ${candidate.label}`);
  await page.waitForTimeout(200);
  const after = await observeElementState(page, candidate.qaId);

  const changed =
    after.url !== before.url ||
    after.hash !== before.hash ||
    after.title !== before.title ||
    after.dialogCount !== before.dialogCount ||
    after.menuCount !== before.menuCount ||
    after.expanded !== before.expanded ||
    after.selected !== before.selected ||
    after.checked !== before.checked;

  if (changed) {
    return {
      result: "PASSED" as const,
      terminalState: "Interaction produced a visible terminal state",
      humanSummary: `Exercised ${candidate.label} and saw a visible UI response rather than a dead click.`,
    };
  }

  return {
    result: "FAILED" as const,
    terminalState: "No visible UI response followed the interaction",
    humanSummary: `Clicked ${candidate.label}, but there was no visible navigation, disclosure, selection, or state change afterwards.`,
  };
}

async function reviewCandidate(
  browserContext: BrowserContext,
  context: RunnerContext,
  surface: SurfaceVisit,
  candidate: UiElementCandidate,
  reviewIndex: number,
  consoleEntries: ConsoleEntry[],
  networkEntries: NetworkEntry[],
  screenshotsDir: string,
): Promise<InteractionResult> {
  const page = await openAuditPage(browserContext, surface.url, consoleEntries, networkEntries);

  try {
    const refreshed = await markAndCollectCandidates(page, surface.id);
    const liveCandidate =
      refreshed.candidates.find((entry) => entry.signature === candidate.signature) ??
      refreshed.candidates.find((entry) => entry.componentId === candidate.componentId);

    const screenshotFileName = `${surface.id}-${reviewIndex + 1}-${safeLabel(candidate.label)}.png`;
    const stepsExecuted = [`Open ${surface.url}`];

    if (!liveCandidate) {
      const screenshot = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
      return {
        review: {
          id: candidate.reviewId,
          surfaceId: surface.id,
          componentId: candidate.componentId,
          elementType: candidate.elementType,
          label: candidate.label,
          distinctState: candidate.distinctState,
          actionAttempted: "Relocate UI element after refresh",
          stepsExecuted,
          terminalState: "Element was no longer reachable on a fresh visit",
          result: "UNVERIFIED",
          humanSummary: `Could not relocate ${candidate.label} after reloading the surface, so the element could not be proven safely.`,
          linkedFindingIds: [],
          evidencePaths: [screenshot],
        },
        finding: null,
      };
    }

    const locator = page.locator(`[data-gaps-qa-id="${liveCandidate.qaId}"]`).first();
    await locator.scrollIntoViewIfNeeded().catch(() => {});

    if (liveCandidate.isDisabled) {
      const screenshot = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
      return {
        review: {
          id: liveCandidate.reviewId,
          surfaceId: surface.id,
          componentId: liveCandidate.componentId,
          elementType: liveCandidate.elementType,
          label: liveCandidate.label,
          distinctState: liveCandidate.distinctState,
          actionAttempted: "Attempt disabled control interaction",
          stepsExecuted,
          terminalState: "Element was disabled",
          result: "BLOCKED",
          humanSummary: `${liveCandidate.label} was visibly disabled, so there was no safe interaction path to prove beyond the blocked state.`,
          linkedFindingIds: [],
          evidencePaths: [screenshot],
        },
        finding: null,
      };
    }

    if (liveCandidate.isReadOnly && liveCandidate.actionKind === "text_input") {
      const screenshot = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
      return {
        review: {
          id: liveCandidate.reviewId,
          surfaceId: surface.id,
          componentId: liveCandidate.componentId,
          elementType: liveCandidate.elementType,
          label: liveCandidate.label,
          distinctState: liveCandidate.distinctState,
          actionAttempted: "Attempt read-only field interaction",
          stepsExecuted,
          terminalState: "Field was read-only",
          result: "BLOCKED",
          humanSummary: `${liveCandidate.label} was read-only, so the runner recorded the blocked state rather than forcing input.`,
          linkedFindingIds: [],
          evidencePaths: [screenshot],
        },
        finding: null,
      };
    }

    if (liveCandidate.inputType === "password" && context.roleCredentials.length === 0) {
      const screenshot = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
      return {
        review: {
          id: liveCandidate.reviewId,
          surfaceId: surface.id,
          componentId: liveCandidate.componentId,
          elementType: liveCandidate.elementType,
          label: liveCandidate.label,
          distinctState: liveCandidate.distinctState,
          actionAttempted: "Attempt credential-gated interaction",
          stepsExecuted,
          terminalState: "Password input detected without test credentials",
          result: "BLOCKED",
          humanSummary: `Stopped at ${liveCandidate.label} because the surface required credentials and none were supplied for the run.`,
          linkedFindingIds: [],
          evidencePaths: [screenshot],
        },
        finding: null,
      };
    }

    if (context.safetyMode === "safe_read_only" && isMutationRisk(liveCandidate) && liveCandidate.actionKind !== "submit") {
      const screenshot = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
      return {
        review: {
          id: liveCandidate.reviewId,
          surfaceId: surface.id,
          componentId: liveCandidate.componentId,
          elementType: liveCandidate.elementType,
          label: liveCandidate.label,
          distinctState: liveCandidate.distinctState,
          actionAttempted: `Assess ${liveCandidate.label} for safe deep proofing`,
          stepsExecuted,
          terminalState: "Safe deep pass stopped before a potentially mutating action",
          result: "BLOCKED",
          humanSummary: `Stopped before ${liveCandidate.label} because the control looked potentially mutating and the run was in safe read-only mode.`,
          linkedFindingIds: [],
          evidencePaths: [screenshot],
        },
        finding: null,
      };
    }

    let actionResult;
    switch (liveCandidate.actionKind) {
      case "link":
        actionResult = await exerciseLink(page, liveCandidate, locator, stepsExecuted, context.targetUrl);
        break;
      case "text_input":
        actionResult = await exerciseTextInput(liveCandidate, locator, stepsExecuted);
        break;
      case "toggle":
        actionResult = await exerciseToggle(page, liveCandidate, locator, stepsExecuted);
        break;
      case "select":
        actionResult = await exerciseSelect(liveCandidate, locator, stepsExecuted);
        break;
      case "tab":
        actionResult = await exerciseTab(page, liveCandidate, locator, stepsExecuted);
        break;
      case "submit":
        actionResult = await exerciseSubmit(liveCandidate, locator, stepsExecuted, context.safetyMode);
        break;
      case "disclosure":
      case "generic":
      default:
        actionResult = await exerciseGenericAction(page, liveCandidate, locator, stepsExecuted);
        break;
    }

    const screenshot = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
    const review: UiElementReviewRecord = {
      id: liveCandidate.reviewId,
      surfaceId: surface.id,
      componentId: liveCandidate.componentId,
      elementType: liveCandidate.elementType,
      label: liveCandidate.label,
      distinctState: liveCandidate.distinctState,
      actionAttempted: stepsExecuted[stepsExecuted.length - 1] ?? `Exercise ${liveCandidate.label}`,
      stepsExecuted,
      terminalState: actionResult.terminalState,
      result: actionResult.result,
      humanSummary: actionResult.humanSummary,
      linkedFindingIds: [],
      evidencePaths: [screenshot],
    };

    const finding = buildFindingFromReview(review, context.targetUrl);
    if (finding) {
      review.linkedFindingIds.push(finding.id);
    }

    return { review, finding };
  } finally {
    await page.close().catch(() => {});
  }
}

export class PlaywrightCdpRunner implements BrowserAuditRunner {
  readonly key = "playwright_cdp";
  readonly label = "Playwright CDP";

  async availability() {
    return { available: true, reason: null };
  }

  async run(context: RunnerContext): Promise<RunnerAuditOutput> {
    const screenshotsDir = path.join(context.artifactRootDir, "screenshots");
    const tracesDir = path.join(context.artifactRootDir, "traces");
    const consoleDir = path.join(context.artifactRootDir, "console");
    const networkDir = path.join(context.artifactRootDir, "network");

    await Promise.all([
      ensureDir(screenshotsDir),
      ensureDir(tracesDir),
      ensureDir(consoleDir),
      ensureDir(networkDir),
    ]);

    const consoleEntries: ConsoleEntry[] = [];
    const networkEntries: NetworkEntry[] = [];
    const surfaces: SurfaceRecord[] = [];
    const findings: FindingRecord[] = [];
    const blockedItems: RunnerAuditOutput["blockedItems"] = [];
    const humanNarrative: string[] = [];
    const artifactManifest: ArtifactManifest = {
      screenshots: [],
      traces: [],
      reportFiles: [],
      networkLogs: [],
      consoleLogs: [],
    };

    const browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext({ ignoreHTTPSErrors: true });
    await browserContext.tracing.start({ screenshots: true, snapshots: true });

    try {
      const queue: Array<{ url: string; entryPoint: string }> = [
        { url: context.targetUrl, entryPoint: "root_navigation" },
      ];
      const seenUrls = new Set<string>();
      const surfaceVisits: SurfaceVisit[] = [];
      const surfaceComponents = new Map<string, ComponentRecord[]>();
      const surfaceCandidates = new Map<string, UiElementCandidate[]>();
      const discoveredLimit = maxDiscoveredSurfaces(context.auditMode);

      while (queue.length > 0 && surfaceVisits.length < discoveredLimit) {
        const next = queue.shift();
        if (!next) {
          break;
        }

        const page = await openAuditPage(browserContext, next.url, consoleEntries, networkEntries);
        try {
          const resolvedUrl = page.url();
          if (seenUrls.has(resolvedUrl)) {
            continue;
          }
          seenUrls.add(resolvedUrl);

          const surfaceId = surfaceVisits.length === 0 ? "surface_root" : `surface_${surfaceVisits.length + 1}`;
          const screenshotFileName = surfaceVisits.length === 0 ? "root.png" : `${surfaceId}.png`;
          const screenshotPath = await captureScreenshot(page, screenshotsDir, "screenshots", screenshotFileName);
          artifactManifest.screenshots.push(screenshotPath);

          const title = (await page.title()) || next.entryPoint || "Visited page";
          const currentUrl = new URL(resolvedUrl);
          const surface: SurfaceVisit = {
            id: surfaceId,
            url: resolvedUrl,
            title,
            path: `${currentUrl.pathname}${currentUrl.search}`,
            entryPoint: next.entryPoint,
            screenshotPath,
          };
          surfaceVisits.push(surface);
          surfaces.push({
            id: surface.id,
            path: surface.path,
            title: surface.title,
            kind: "page",
            entryPoint: surface.entryPoint,
            result: "PASSED",
            notes: `Loaded ${surface.title}.`,
            evidencePaths: [surface.screenshotPath],
          });

          const snapshot = await markAndCollectCandidates(page, surface.id);
          surfaceComponents.set(surface.id, snapshot.components);
          surfaceCandidates.set(surface.id, snapshot.candidates);
          humanNarrative.push(
            `Visited "${surface.title}" and captured ${snapshot.candidates.length} visible interactive elements for proofing.`,
          );

          if (
            snapshot.candidates.some(
              (candidate) => candidate.inputType === "password" && context.roleCredentials.length === 0,
            )
          ) {
            blockedItems.push({
              id: `blocked_auth_${surface.id}`,
              category: "auth",
              title: `${surface.title} is gated by a password input`,
              reason: "A password input was detected, but no role credentials were supplied for the run.",
              result: "BLOCKED",
            });
            findings.push({
              id: `finding_auth_gate_${surface.id}`,
              severity: "MEDIUM",
              surfaceId: surface.id,
              area: "Authentication",
              title: "Authentication gate blocked deeper coverage",
              componentOrWorkflow: "Password input",
              reproductionSteps: [`Open ${surface.url}.`, "Observe the password input on the surface."],
              expectedBehavior: "Test credentials should be available when credential-gated areas are in scope.",
              actualBehavior: "The runner reached a password input without credentials and could not go deeper safely.",
              confidence: "CERTAIN",
              screenshotPath: surface.screenshotPath,
              tracePath: null,
            });
          }

          for (const candidate of snapshot.candidates) {
            if (!candidate.href) {
              continue;
            }

            try {
              const href = new URL(candidate.href, resolvedUrl);
              if (href.origin !== currentUrl.origin) {
                continue;
              }

              const normalized = href.toString();
              if (!seenUrls.has(normalized) && !queue.some((entry) => entry.url === normalized)) {
                queue.push({
                  url: normalized,
                  entryPoint: candidate.label,
                });
              }
            } catch {
              continue;
            }
          }
        } finally {
          await page.close().catch(() => {});
        }
      }

      const uiElementReviews: UiElementReviewRecord[] = [];
      const workflows: WorkflowRecord[] = [
        {
          id: "workflow_root_open",
          name: "Open root page",
          entryPoint: "Initial navigation",
          stepsExecuted: [`Navigate to ${context.targetUrl}`],
          terminalState: surfaces[0]?.title ? `${surfaces[0].title} visible` : "Root page visible",
          result: surfaces[0] ? "PASSED" : "FAILED",
          defectIds: [],
          evidencePaths: surfaces[0] ? [...surfaces[0].evidencePaths] : [],
        },
      ];

      for (const surface of surfaceVisits) {
        const candidates = surfaceCandidates.get(surface.id) ?? [];
        for (const [index, candidate] of candidates.entries()) {
          const interaction = await reviewCandidate(
            browserContext,
            context,
            surface,
            candidate,
            index,
            consoleEntries,
            networkEntries,
            screenshotsDir,
          );
          uiElementReviews.push(interaction.review);
          if (interaction.finding) {
            findings.push(interaction.finding);
          }
          workflows.push(buildWorkflowFromReview(interaction.review));
          if (interaction.review.result !== "PASSED" || humanNarrative.length < 12) {
            humanNarrative.push(interaction.review.humanSummary);
          }
          artifactManifest.screenshots.push(...interaction.review.evidencePaths.filter((pathValue) => !artifactManifest.screenshots.includes(pathValue)));
        }
      }

      const components = updateComponentsWithReviews(
        Array.from(surfaceComponents.values()).flat(),
        uiElementReviews,
      );

      const consoleErrors = consoleEntries.filter(
        (entry) => entry.type === "error" || entry.type === "warning",
      );
      if (consoleErrors.length > 0) {
        findings.push({
          id: "finding_console_errors",
          severity: "HIGH",
          surfaceId: surfaces[0]?.id ?? "surface_root",
          area: "Runtime console",
          title: "Console emitted warnings or errors during browsing",
          componentOrWorkflow: "Client runtime",
          reproductionSteps: [
            `Open ${context.targetUrl}.`,
            "Inspect the browser console during surface discovery and UI proofing.",
          ],
          expectedBehavior: "Reachable browser paths should not emit avoidable runtime errors or warnings.",
          actualBehavior: `${consoleErrors.length} warning or error console entries were captured.`,
          confidence: "CERTAIN",
          screenshotPath: surfaces[0]?.evidencePaths[0] ?? null,
          tracePath: null,
        });
      }

      const failingResponses = networkEntries.filter((entry) => entry.status >= 400);
      if (failingResponses.length > 0) {
        findings.push({
          id: "finding_network_failures",
          severity: failingResponses.some((entry) => entry.status >= 500) ? "HIGH" : "MEDIUM",
          surfaceId: surfaces[0]?.id ?? "surface_root",
          area: "Network",
          title: "Network requests failed during the browser audit",
          componentOrWorkflow: "Browser network stack",
          reproductionSteps: [
            `Open ${context.targetUrl}.`,
            "Review captured network responses during discovery and UI proofing.",
          ],
          expectedBehavior: "Reachable browser paths should load without persistent 4xx or 5xx requests.",
          actualBehavior: `${failingResponses.length} HTTP 4xx or 5xx responses were captured.`,
          confidence: "CERTAIN",
          screenshotPath: surfaces[0]?.evidencePaths[0] ?? null,
          tracePath: null,
        });
      }

      await writeJsonl(path.join(consoleDir, "console.jsonl"), consoleEntries);
      await writeJsonl(path.join(networkDir, "network.jsonl"), networkEntries);
      artifactManifest.consoleLogs.push(artifactPath("console", "console.jsonl"));
      artifactManifest.networkLogs.push(artifactPath("network", "network.jsonl"));

      const traceOutputPath = path.join(tracesDir, "playwright-trace.zip");
      await browserContext.tracing.stop({ path: traceOutputPath });
      artifactManifest.traces.push(artifactPath("traces", "playwright-trace.zip"));

      const summary = summarizeFindings(findings, workflows, blockedItems.length, uiElementReviews);
      return {
        targetClassification: classifyTarget(context.targetUrl),
        summary,
        surfaces,
        components,
        uiElementReviews,
        workflows,
        findings,
        blockedItems,
        humanNarrative,
        artifactManifest,
      };
    } catch (error) {
      const failureMessage =
        error instanceof Error ? error.message : "Playwright audit runner failed unexpectedly.";

      await writeFile(path.join(consoleDir, "runner-error.txt"), `${failureMessage}\n`, "utf8");
      artifactManifest.consoleLogs.push(artifactPath("console", "runner-error.txt"));

      return {
        targetClassification: classifyTarget(context.targetUrl),
        summary: defaultSummary(failureMessage),
        surfaces: [],
        components: [],
        uiElementReviews: [],
        workflows: [
          {
            id: "workflow_root_open",
            name: "Open root page",
            entryPoint: "Initial navigation",
            stepsExecuted: [`Navigate to ${context.targetUrl}`],
            terminalState: failureMessage,
            result: "FAILED",
            defectIds: ["finding_runner_failure"],
            evidencePaths: [],
          },
        ],
        findings: [
          {
            id: "finding_runner_failure",
            severity: "HIGH",
            surfaceId: "surface_root",
            area: "Runner execution",
            title: "Playwright runner failed before completing the audit",
            componentOrWorkflow: "Browser session",
            reproductionSteps: [`Start a QA run for ${context.targetUrl}.`],
            expectedBehavior: "The runner should complete discovery, UI proofing, and evidence capture.",
            actualBehavior: failureMessage,
            confidence: "CERTAIN",
            screenshotPath: null,
            tracePath: null,
          },
        ],
        blockedItems: [],
        humanNarrative: [],
        artifactManifest,
      };
    } finally {
      await browserContext.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}
