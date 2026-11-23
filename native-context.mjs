// Generated from unchanged DSH ContextMeter sources; see vendor/dsh-context.
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as UiPrimitives from '@deepseek-ai/dsh-client-ui-primitives'
export const ContextMeter = (()=>{const module={exports:{}};const require=name=>name==='react'?React:name==='react-dom'?ReactDOM:UiPrimitives;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// vendor/dsh-context/skeleton/ContextMeter.tsx
var ContextMeter_exports = {};
__export(ContextMeter_exports, {
  ContextMeter: () => ContextMeter
});
module.exports = __toCommonJS(ContextMeter_exports);
var import_react = require("react");
var import_react_dom = require("react-dom");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// vendor/dsh-context/context-occupancy.ts
function contextOccupancy(pressure) {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
  if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow
  };
}

// vendor/dsh-context/skeleton/ContextMeter.module.css
var ContextMeter_default = {
  root: "ContextMeter_root",
  trigger: "ContextMeter_trigger",
  track: "ContextMeter_track",
  fill: "ContextMeter_fill",
  panel: "ContextMeter_panel",
  header: "ContextMeter_header",
  figures: "ContextMeter_figures",
  percent: "ContextMeter_percent",
  headline: "ContextMeter_headline",
  bar: "ContextMeter_bar",
  segment: "ContextMeter_segment",
  swatch: "ContextMeter_swatch",
  colorSystem: "ContextMeter_colorSystem",
  colorTools: "ContextMeter_colorTools",
  colorMessages: "ContextMeter_colorMessages",
  rows: "ContextMeter_rows",
  row: "ContextMeter_row"
};

// vendor/dsh-context/skeleton/ContextMeter.tsx
var RADIUS = 5.5;
var CIRCUMFERENCE = 2 * Math.PI * RADIUS;
var READING_SLOT = "\0";
var ROWS = [
  { key: "systemTokens", label: "context.system", color: ContextMeter_default.colorSystem },
  { key: "toolsTokens", label: "context.tools", color: ContextMeter_default.colorTools },
  { key: "messageTokens", label: "context.messages", color: ContextMeter_default.colorMessages }
];
function formatTokens(value, t) {
  const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  if (value < 1e6) return t("number.thousand", { value: scaled(value / 1e3) });
  return t("number.million", { value: scaled(value / 1e6) });
}
function ContextMeter({ useProjection, t }) {
  const pressure = useProjection("contextPressure");
  const breakdown = useProjection("contextBreakdown");
  const [open, setOpen] = (0, import_react.useState)(false);
  const rootRef = (0, import_react.useRef)(null);
  const panelRef = (0, import_react.useRef)(null);
  const context = contextOccupancy(pressure);
  const available = context !== null;
  const anchorName = `--dsh-context-${(0, import_react.useId)().replaceAll(":", "")}`;
  (0, import_dsh_client_ui_primitives.useDismissOnOutsidePointer)(rootRef, open && available, setOpen, panelRef);
  (0, import_react.useEffect)(() => {
    if (!available && open) setOpen(false);
  }, [available, open]);
  (0, import_react.useEffect)(() => {
    if (!open || !available) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [available, open]);
  if (context === null) return null;
  const percent = context.percent;
  const reading = `${percent}%`;
  const [headBefore = "", headAfter = ""] = t("context.aria", { percent: READING_SLOT }).split(READING_SLOT).map((part) => part.trim());
  const breakdownTotal = breakdown === void 0 ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;
  const parts = breakdown === void 0 || breakdownTotal === 0 ? [{ key: "total", color: void 0, width: percent }] : ROWS.map((row) => ({ key: row.key, color: row.color, width: percent * breakdown[row.key] / breakdownTotal }));
  const segments = parts.filter((part) => part.width > 0);
  return /* @__PURE__ */ React.createElement("span", { ref: rootRef, style: { anchorName }, className: ContextMeter_default.root }, /* @__PURE__ */ React.createElement(import_dsh_client_ui_primitives.Tooltip, { label: t("context.aria", { percent: reading }), side: "top", delayMs: 200, disabled: open, portal: true }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: ContextMeter_default.trigger,
      "aria-label": t("context.aria", { percent: reading }),
      "aria-haspopup": "dialog",
      "aria-expanded": open,
      onClick: () => {
        setOpen(!open);
      }
    },
    /* @__PURE__ */ React.createElement("svg", { viewBox: "0 0 14 14", width: "14", height: "14", "aria-hidden": true }, /* @__PURE__ */ React.createElement("circle", { className: ContextMeter_default.track, cx: "7", cy: "7", r: RADIUS }), /* @__PURE__ */ React.createElement(
      "circle",
      {
        className: ContextMeter_default.fill,
        cx: "7",
        cy: "7",
        r: RADIUS,
        strokeDasharray: `${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`,
        transform: "rotate(-90 7 7)"
      }
    )),
    /* @__PURE__ */ React.createElement("span", null, reading)
  )), open && (0, import_react_dom.createPortal)(
    /* @__PURE__ */ React.createElement(
      "div",
      {
        ref: panelRef,
        className: ContextMeter_default.panel,
        style: { positionAnchor: anchorName },
        role: "dialog",
        "aria-label": t("context.used")
      },
      /* @__PURE__ */ React.createElement("div", { className: ContextMeter_default.header }, /* @__PURE__ */ React.createElement("span", { className: ContextMeter_default.headline }, headBefore), /* @__PURE__ */ React.createElement("span", { className: ContextMeter_default.percent }, reading), /* @__PURE__ */ React.createElement("span", { className: ContextMeter_default.headline }, headAfter), /* @__PURE__ */ React.createElement("span", { className: ContextMeter_default.figures }, `~${formatTokens(context.usedTokens, t)} / ${formatTokens(context.contextWindow, t)}`)),
      /* @__PURE__ */ React.createElement("div", { className: ContextMeter_default.bar }, segments.map((segment) => /* @__PURE__ */ React.createElement(
        "div",
        {
          key: segment.key,
          className: segment.color === void 0 ? ContextMeter_default.segment : `${ContextMeter_default.segment} ${segment.color}`,
          style: { width: `${segment.width}%` }
        }
      ))),
      breakdown !== void 0 && /* @__PURE__ */ React.createElement("dl", { className: ContextMeter_default.rows }, ROWS.map((row) => /* @__PURE__ */ React.createElement("div", { key: row.key, className: ContextMeter_default.row }, /* @__PURE__ */ React.createElement("dt", null, /* @__PURE__ */ React.createElement("span", { className: `${ContextMeter_default.swatch} ${row.color}`, "aria-hidden": true }), t(row.label)), /* @__PURE__ */ React.createElement("dd", null, `~${formatTokens(breakdown[row.key], t)}`))))
    ),
    document.body
  ));
}

return module.exports.ContextMeter})();
export const nativeContextCss="/* vendor/dsh-context/skeleton/ContextMeter.module.css */\n.ContextMeter_root {\n  display: inline-flex;\n  flex: none;\n}\n.ContextMeter_trigger {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  flex: none;\n  padding: 1px 8px;\n  border: none;\n  border-radius: var(--dsw-radius-sm);\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary);\n  font-family: inherit;\n  font-size: var(--dsh-content-font-size-secondary, 13px);\n  font-variant-numeric: tabular-nums;\n  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));\n  white-space: nowrap;\n  cursor: pointer;\n}\n.ContextMeter_trigger[aria-expanded=true] {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-secondary);\n}\n@media (hover: hover) {\n  .ContextMeter_trigger:hover {\n    background: var(--dsw-alias-interactive-bg-hover);\n    color: var(--dsw-alias-label-secondary);\n  }\n}\n.ContextMeter_track {\n  fill: none;\n  stroke: var(--dsw-alias-border-l3);\n  stroke-width: 2;\n}\n.ContextMeter_fill {\n  fill: none;\n  stroke: var(--dsw-alias-label-tertiary);\n  stroke-width: 2;\n  stroke-linecap: round;\n}\n.ContextMeter_panel {\n  position: fixed;\n  z-index: 1100;\n  box-sizing: border-box;\n  width: min(264px, calc(100vw - 24px));\n  padding: 12px;\n  border: 0;\n  border-radius: var(--dsw-radius-lg);\n  background: var(--dsw-specific-menu);\n  backdrop-filter: var(--dsw-menu-backdrop-filter);\n  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);\n  box-shadow: var(--dsw-elevation-prominent);\n  font-size: 12px;\n  line-height: 20px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: default;\n  max-width: calc(100vw - 24px);\n  max-height: calc(100dvh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));\n  overflow-x: hidden;\n  overflow-y: auto;\n  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);\n  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);\n  position-area: none;\n  top: max(12px, var(--dsh-frame-overlay-top, 12px));\n  bottom: max(12px, calc(anchor(top) + 8px));\n  left: max(12px, anchor(left));\n  right: 12px;\n  position-try-fallbacks:\n    --dsh-context-window,\n    --dsh-context-opposite,\n    --dsh-context-wide-opposite,\n    --dsh-context-tall,\n    --dsh-context-viewport;\n  align-self: end;\n  justify-self: start;\n  height: fit-content;\n  min-height: 0;\n  margin: 0;\n}\n.ContextMeter_header {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n.ContextMeter_figures {\n  margin-left: auto;\n  font-weight: 500;\n  font-variant-numeric: tabular-nums;\n  color: var(--dsw-alias-label-primary);\n}\n.ContextMeter_percent {\n  font-weight: 500;\n  color: var(--dsw-alias-label-primary);\n}\n.ContextMeter_headline {\n  color: var(--dsw-alias-label-tertiary);\n}\n.ContextMeter_headline:empty {\n  display: none;\n}\n.ContextMeter_bar {\n  display: flex;\n  gap: 1px;\n  margin: 10px 0 12px;\n  height: 4px;\n  border-radius: 999px;\n  corner-shape: round;\n  background: var(--dsw-alias-interactive-bg-hover);\n  overflow: hidden;\n}\n.ContextMeter_segment {\n  flex: none;\n  min-width: 2px;\n  height: 100%;\n  border-radius: 1px;\n  background: var(--meter-tint, var(--dsw-alias-label-tertiary));\n}\n.ContextMeter_swatch {\n  display: inline-block;\n  margin-right: 6px;\n  width: 8px;\n  height: 8px;\n  border-radius: 2px;\n  background: var(--meter-tint);\n  vertical-align: baseline;\n}\n.ContextMeter_colorSystem {\n  --meter-tint: var(--dsw-static-neutral-bluish-400);\n}\n.ContextMeter_colorTools {\n  --meter-tint: rgb(167, 139, 250);\n}\n.ContextMeter_colorMessages {\n  --meter-tint: var(--dsw-static-blue-450);\n}\n.ContextMeter_rows {\n  margin: 6px 0 0;\n}\n.ContextMeter_row {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 2px 0;\n}\n.ContextMeter_row dt {\n  color: var(--dsw-alias-label-secondary);\n}\n.ContextMeter_row dd {\n  margin: 0;\n  font-variant-numeric: tabular-nums;\n  color: var(--dsw-alias-label-primary);\n}\n@position-try --dsh-context-window {\n  position-area: none;\n  top: max(12px, var(--dsh-frame-overlay-top, 12px));\n  bottom: max(12px, calc(anchor(top) + 8px));\n  left: 12px;\n  right: 12px;\n  margin: 0;\n  align-self: safe end;\n  justify-self: safe end;\n}\n@position-try --dsh-context-opposite {\n  top: max(12px, calc(anchor(bottom) + 8px));\n  bottom: 12px;\n  align-self: start;\n}\n@position-try --dsh-context-wide-opposite {\n  top: max(12px, calc(anchor(bottom) + 8px));\n  bottom: 12px;\n  left: 12px;\n  right: 12px;\n  align-self: start;\n  justify-self: safe end;\n}\n@position-try --dsh-context-tall {\n  position-area: none;\n  top: max(12px, var(--dsh-frame-overlay-top, 12px));\n  bottom: 12px;\n  left: max(12px, anchor(left));\n  right: 12px;\n  margin: 0;\n  align-self: safe start;\n  justify-self: start;\n}\n@position-try --dsh-context-viewport {\n  position-area: none;\n  inset: max(12px, var(--dsh-frame-overlay-top, 12px)) 12px 12px;\n  margin: 0;\n  align-self: safe start;\n  justify-self: safe end;\n}\n"
