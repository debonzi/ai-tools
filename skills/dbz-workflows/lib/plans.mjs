import {
	ConfirmationRequiredError,
	PlanMismatchError,
	ValidationError,
} from "./errors.mjs";
import { sha256Hex } from "./filesystem.mjs";

export const PLAN_VERSION = 1;

function assertPlainObject(value, name) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ValidationError(`${name} must be an object.`);
	}
}

function canonicalize(value) {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

export function calculatePlanDigest(plan) {
	assertPlainObject(plan, "plan");
	const unsigned = { ...plan };
	delete unsigned.plan_digest;
	return sha256Hex(`${JSON.stringify(canonicalize(unsigned))}\n`);
}

export function finalizePlan(plan) {
	return { ...plan, plan_digest: calculatePlanDigest(plan) };
}

export function validateReviewedPlan(plan, operation, { planVersion = PLAN_VERSION } = {}) {
	assertPlainObject(plan, "plan");
	if (plan.plan_version !== planVersion || plan.operation !== operation) {
		throw new PlanMismatchError(`Expected a version ${planVersion} '${operation}' plan.`);
	}
	const actualDigest = calculatePlanDigest(plan);
	if (typeof plan.plan_digest !== "string" || plan.plan_digest !== actualDigest) {
		throw new PlanMismatchError("The plan content does not match its recorded digest.", {
			details: { recorded_digest: plan.plan_digest, actual_digest: actualDigest },
		});
	}
	return plan;
}

export function requirePlanAuthorization(plan, authorization) {
	if (
		authorization?.confirmed !== true ||
		typeof authorization?.planDigest !== "string" ||
		authorization.planDigest !== plan.plan_digest
	) {
		throw new ConfirmationRequiredError(
			"Apply requires explicit authorization tied to the exact reviewed plan digest.",
			{ details: { plan_digest: plan.plan_digest } },
		);
	}
}
