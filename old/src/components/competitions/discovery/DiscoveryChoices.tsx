"use client";

import { cn } from "@/lib/utils";
import { DISCOVERY_FIELD_TEXT_MAX_LENGTH, type DiscoveryFieldAnswer } from "@/lib/competitions/discovery/contracts";

export type DiscoveryChoiceOption = { value: string; label: string; meaning?: string };
export type DiscoveryChoiceField = {
  id: string;
  label: string;
  hint?: string;
  selection: "single" | "multiple" | "ranked";
  maxSelections?: number;
  exclusiveValues?: readonly string[];
  options: readonly DiscoveryChoiceOption[];
};
export type DiscoveryChoiceValue = DiscoveryFieldAnswer;

export function toggleDiscoveryChoice(field: DiscoveryChoiceField, previous: readonly string[], value: string): string[] {
  if (!field.options.some(option => option.value === value)) return [...previous];
  if (field.selection === "single") return [value];
  if (previous.includes(value)) return previous.filter(item => item !== value);
  if (field.exclusiveValues?.includes(value)) return [value];
  const selected = previous.filter(item => !field.exclusiveValues?.includes(item));
  if (field.maxSelections && selected.length >= field.maxSelections) return [...previous];
  return [...selected, value];
}

export function moveDiscoveryPriority(values: readonly string[], index: number, direction: -1 | 1): string[] {
  const destination = index + direction;
  if (index < 0 || index >= values.length || destination < 0 || destination >= values.length) return [...values];
  const next = [...values];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}

const compactButton = "min-h-11 rounded-full px-3 text-sm font-semibold text-brand-700 underline underline-offset-4 disabled:cursor-not-allowed disabled:opacity-35";

export function DiscoveryChoices({ field, answer, onChange, disabled = false }: {
  field: DiscoveryChoiceField;
  answer: DiscoveryChoiceValue;
  onChange: (answer: DiscoveryChoiceValue) => void;
  disabled?: boolean;
}) {
  const selected = answer.status === "answered" ? answer.values : [];
  const multiple = field.selection !== "single";
  const ranked = field.selection === "ranked";
  const hintId = `${field.id}-hint`;
  const selectedIsExclusive = selected.some(value => field.exclusiveValues?.includes(value));
  const atLimit = multiple && Boolean(field.maxSelections && selected.length >= field.maxSelections && !selectedIsExclusive);
  const text = answer.text ?? "";
  const changeValues = (values: string[]) => onChange({ status: values.length || text.trim() ? "answered" : "unanswered", values, ...(text ? { text } : {}), ...(ranked && values.length ? { orderConfirmed: values.length < 2 } : {}) });

  return <fieldset disabled={disabled} aria-describedby={field.hint ? hintId : undefined} className="min-w-0 space-y-4" data-field-id={field.id}>
    <legend className="text-base font-semibold leading-7 text-ink md:text-lg">{field.label}</legend>
    {field.hint ? <p className="text-sm leading-6 text-muted-foreground" id={hintId}>{field.hint}</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {field.options.map(option => {
        const checked = selected.includes(option.value);
        const optionDisabled = disabled || atLimit && !checked && !field.exclusiveValues?.includes(option.value);
        return <label key={option.value} className={cn("relative flex min-h-16 cursor-pointer items-start gap-3 rounded-2xl border bg-white p-4 transition-colors", checked ? "border-brand-500 bg-brand-50 shadow-soft" : "border-control-border hover:border-brand-400", optionDisabled && "cursor-not-allowed opacity-40")}>
          <input className="peer sr-only" type={multiple ? "checkbox" : "radio"} name={field.id} checked={checked} value={option.value} disabled={optionDisabled}
            onChange={() => changeValues(toggleDiscoveryChoice(field, selected, option.value))} />
          <span aria-hidden="true" className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-xs font-semibold peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-brand-500", multiple ? "rounded-md" : "rounded-full", checked ? "border-brand-500 bg-brand-500 text-white" : "border-control-border text-transparent")}>{multiple ? "✓" : "•"}</span>
          <span className="text-sm font-semibold leading-6 text-ink">{option.label}</span>
        </label>;
      })}
    </div>
    {multiple && field.maxSelections ? <p className="text-xs text-muted-foreground">已选 {selected.length}/{field.maxSelections} 项{ranked ? "；请在下方明确优先顺序" : ""}</p> : null}
    {ranked && selected.length > 1 ? <div className="space-y-3 rounded-2xl bg-brand-50/70 p-4" aria-label="目标优先顺序">
      <p className="text-sm font-semibold text-brand-800">按你的真实偏好调整顺序</p>
      <ol className="space-y-2">
        {selected.map((value, index) => <li key={value} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white px-3 py-2">
          <span className="text-sm font-semibold text-brand-700">第{index + 1}优先</span>
          <span className="min-w-0 flex-1 text-sm leading-6">{field.options.find(option => option.value === value)?.label}</span>
          <div className="flex gap-1">
            <button type="button" className={compactButton} disabled={disabled || index === 0} aria-label={`提高${field.options.find(option => option.value === value)?.label}的优先级`} onClick={() => changeValues(moveDiscoveryPriority(selected, index, -1))}>上移</button>
            <button type="button" className={compactButton} disabled={disabled || index === selected.length - 1} aria-label={`降低${field.options.find(option => option.value === value)?.label}的优先级`} onClick={() => changeValues(moveDiscoveryPriority(selected, index, 1))}>下移</button>
          </div>
        </li>)}
      </ol>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold text-brand-800">
        <input type="checkbox" checked={answer.orderConfirmed === true} onChange={event => onChange({ ...answer, orderConfirmed: event.target.checked })} />我确认以上目标顺序
      </label>
    </div> : null}
    {selected.length ? <button className={compactButton} disabled={disabled} type="button" onClick={() => changeValues([])}>清除已选选项</button> : null}
    <div className="space-y-2">
      <label htmlFor={`${field.id}-text`} className="block text-sm font-semibold text-ink">也可以自己填写</label>
      <p id={`${field.id}-text-hint`} className="text-xs leading-6 text-muted-foreground">可以只选选项、只写文字，或补充说明；至少回答一种。请勿填写姓名、学校名称或联系方式。</p>
      <textarea id={`${field.id}-text`} aria-describedby={`${field.id}-text-hint ${field.id}-text-count`} disabled={disabled}
        className="min-h-24 w-full resize-y rounded-2xl border border-control-border bg-white p-4 text-sm leading-7 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
        value={text} onChange={event => {
          const next = Array.from(event.target.value).slice(0, DISCOVERY_FIELD_TEXT_MAX_LENGTH).join("");
          onChange({ status: selected.length || next.trim() ? "answered" : "unanswered", values: selected, text: next,
            ...(ranked && selected.length ? { orderConfirmed: answer.orderConfirmed } : {}) });
        }} />
      <p id={`${field.id}-text-count`} className="text-right text-xs text-muted-foreground">{Array.from(text).length}/{DISCOVERY_FIELD_TEXT_MAX_LENGTH} 字</p>
    </div>
  </fieldset>;
}
