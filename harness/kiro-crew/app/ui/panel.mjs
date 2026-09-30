/** A no-props, read-only view of the host-attributed conversation.
 * The SDK supplies request identity; this entry never reads or constructs it.
 * Session decoding/reduction, rendering and scheduling are shared with the page.
 */
import React from "react";
import { useAppApi, useAppInfo, useTheme } from "@kirocrew/app-sdk";
import {
  ATTRIBUTION, DISCLOSURE, CSS, ProgressBody, ErrorDetails, renderFooter, decodeSessionProgress, getDecoded, usePolling, conversationReference,
} from "./index.mjs";

const h = React.createElement;

function ConversationCensus({ view }) {
  const spaces = [...new Set(view.census.map(intent => intent.space))];
  return h("section", { className: "ap-panel" },
    h("h2", null, `This conversation is bound to ${view.project.displayName} but has no intent selected yet`),
    view.census.length === 0 ? h("p", null, "No intents recorded in this project.")
      : spaces.map(space => h("section", { className: "ap-phase", key: space },
        h("h3", null, space),
        h("ul", { className: "ap-blockers" }, view.census.filter(intent => intent.space === space).map(intent =>
          h("li", { key: intent.id }, intent.displayName, " · ", h("span", { className: "ap-mono" }, intent.id),
            !intent.eligible && ` — ${intent.reason ?? "not eligible"}`))))));
}

export default function ProgressPanel() {
  const api = useAppApi();
  const { active } = useAppInfo();
  const { mode } = useTheme();
  const [state, now, send] = usePolling(
    () => getDecoded(api, "/api/apps/aidlc/session-progress", decodeSessionProgress),
    { active, session: true },
  );
  const { view, error } = state;
  const conversationRef = conversationReference(state);
  // Crew's tab wrapper is a bounded block, not a flex parent; include padding in its height.
  return h("main", { className: "aidlc-progress", "data-mode": mode === "light" ? "light" : "dark", style: { height: "100%", boxSizing: "border-box" } },
    h("style", null, CSS),
    h("div", { className: "ap-content" },
      h("header", null, h("p", { className: "ap-kicker" }, "Observe / AI-DLC"),
        h("h1", null, "Conversation progress"),
        conversationRef && h("p", { className: "ap-mono" }, `Conversation ${conversationRef}`)),
      !view && !error && h("p", { role: "status" }, "Loading conversation progress…"),
      view?.state === "ok" && h("h2", null, "This conversation's intent"),
      view?.state === "census" && h(ConversationCensus, { view }),
      view?.state === "unbound" && h("p", { className: "ap-notice", role: "status" }, view.guidance),
      view?.state === "unsupported" && h("section", { className: "ap-notice", role: "status" },
        h("h2", null, "Conversation progress unsupported"), h("p", null, view.reason)),
      error && h("section", { className: "ap-notice" },
        h("h2", null, error.error.code === "BINDING_CHANGED" ? "Conversation binding changed"
          : error.state === "unavailable" ? "Progress unavailable" : "Progress could not be refreshed"),
        h(ErrorDetails, { error: error.error })),
      view?.state !== "unbound" && h(ProgressBody, { state }),
      h(renderFooter, { state, now, send, disclosure: DISCLOSURE, attribution: ATTRIBUTION })));
}
