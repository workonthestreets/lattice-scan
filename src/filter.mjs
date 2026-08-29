// The one filter used for both the ACS snapshot and the update stream:
// WildcardFilter (every contract the party is a stakeholder of) plus the token-standard Holding
// InterfaceFilter so holdings arrive with a normalised view. Verified on DevNet 2026-08-29.
import { config } from "./config.mjs";

export const FILTER = {
  cumulative: [
    { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
    { identifierFilter: { InterfaceFilter: { value: {
      interfaceId: config.holdingInterface,
      includeInterfaceView: true,
      includeCreatedEventBlob: false,
    } } } },
  ],
};

export function eventFormat() {
  if (config.filterMode === "parties") {
    if (!config.parties.length) throw new Error("FILTER_MODE=parties needs PARTIES=<comma list>");
    return { filtersByParty: Object.fromEntries(config.parties.map(p => [p, FILTER])), verbose: false };
  }
  return { filtersForAnyParty: FILTER, verbose: false };
}

export function acsRequest(activeAtOffset) {
  return { filter: eventFormat(), verbose: false, activeAtOffset };
}

export function updatesRequest(beginExclusive) {
  const ef = eventFormat();
  return {
    beginExclusive,
    updateFormat: {
      includeTransactions: { eventFormat: ef, transactionShape: "TRANSACTION_SHAPE_ACS_DELTA" },
      includeReassignments: ef,
    },
    verbose: false,
  };
}
