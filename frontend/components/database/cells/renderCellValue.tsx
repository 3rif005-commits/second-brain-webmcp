"use client";

// Dispatches to the right cell component by `property.type` — extracted out
// of TableView.tsx (task-16) so BoardView's cards can render the exact same
// read/write cell primitives instead of a second cell renderer (task-16-
// brief.md §3: "reuse whatever cell-rendering primitives TableView's cells
// already use for read-only display — do not build a second cell
// renderer"). Anything not in the 8 known types falls back to GenericCell,
// always read-only.
import type {
  EmailValue,
  PhoneValue,
  UrlValue,
  CheckboxValue,
  DateValue,
  MultiSelectValue,
  NumberValue,
  PropertyResponse,
  PropertyValue,
  RelatedRow,
  RichTextValue,
  SelectValue,
  StatusValue,
  TitleValue,
  UnknownValue,
} from "@/lib/database/types";
import { TitleCell } from "./TitleCell";
import { TextCell } from "./TextCell";
import { NumberCell } from "./NumberCell";
import { SelectCell } from "./SelectCell";
import { MultiSelectCell } from "./MultiSelectCell";
import { StatusCell } from "./StatusCell";
import { DateCell } from "./DateCell";
import { CheckboxCell } from "./CheckboxCell";
import { GenericCell } from "./GenericCell";
import type { ConfiguredOption } from "./CellProps";
import { TextLikeCell } from "./TextLikeCell";
import { RelationCell } from "./RelationCell";
import { FormulaCell } from "./FormulaCell";
import { ButtonCell } from "./ButtonCell";

/** Milestone 7's relation cell needs data `CellProps<V>` (value/editable/
 * onChange) has no room for — its value never travels through `onChange`
 * at all (see RelationCell.tsx). Passed as an optional 5th argument so
 * every other caller (Board/Gallery/List/Feed views, all of which predate
 * relations) keeps working unchanged: a "relation"-typed column rendered
 * without this argument falls back to `GenericCell` — the same read-only
 * "—" placeholder those views already showed for relation columns before
 * this task, not a crash (task-22-report.md: relation cells with a real
 * picker are TableView-only in this task's scope). */
export interface RelationCellHandlers {
  links: RelatedRow[] | undefined;
  onEnsureLoaded: () => void;
  onLinksChange: (rows: RelatedRow[]) => void | Promise<void>;
}

/** Milestone 12 (task-42): a button property has no per-row `value` at all
 * (research §25 — "every row shows the same button"), so the one thing it
 * needs from a caller that `CellProps<V>`'s own `value`/`onChange` shape has
 * no room for is which row (note) a click acts on. Same optional-6th-arg,
 * graceful-fallback convention as `relation` above — a caller that omits it
 * (any view besides TableView, not wired by this task) gets the existing
 * read-only `GenericCell` fallback, not a crash. */
export interface ButtonCellHandlers {
  noteId: string;
}

export function renderCellValue(
  property: PropertyResponse,
  value: PropertyValue | undefined,
  editable: boolean,
  onChange: (value: PropertyValue | null) => void,
  relation?: RelationCellHandlers,
  button?: ButtonCellHandlers,
  /** M11 (new-row-button.md): "Focus the new row's title cell after
   * creation." Optional 7th arg, same graceful-fallback convention as
   * `relation`/`button` above — a caller that omits it (RowPeek, every
   * other view) gets TitleCell's pre-existing behavior unchanged. */
  titleAutoEdit?: boolean,
  /** M11 (cell-editing.md): Select's create-on-type — a schema write
   * (`PATCH /api/db/properties/{id}`), which is why it needs its own
   * handler rather than living inside `onChange` (a plain value write).
   * Optional 8th arg, same convention as every other extra above. */
  onCreateSelectOption?: (name: string) => Promise<void>
) {
  switch (property.type) {
    case "title":
      return (
        <TitleCell
          value={value as TitleValue | undefined}
          editable={editable}
          onChange={onChange}
          autoEdit={titleAutoEdit}
        />
      );
    case "rich_text":
      return (
        <TextCell value={value as RichTextValue | undefined} editable={editable} onChange={onChange} />
      );
    case "number":
      return (
        <NumberCell
          value={value as NumberValue | undefined}
          editable={editable}
          onChange={onChange}
          // The one cell whose `config` changes what it RENDERS, not just what
          // it accepts — `Number format` / `Decimal places` / `Show as` are all
          // display-only settings stored on the property.
          config={property.config}
        />
      );
    case "select":
      return (
        <SelectCell
          value={value as SelectValue | undefined}
          editable={editable}
          onChange={onChange}
          // Lets a configured option render in ITS OWN colour rather than a
          // hashed one — the `Colors` list in `Edit property` writes this.
          options={property.config?.options as ConfiguredOption[] | undefined}
          onCreateOption={onCreateSelectOption}
        />
      );
    case "multi_select":
      return (
        <MultiSelectCell
          value={value as MultiSelectValue | undefined}
          editable={editable}
          onChange={onChange}
          // Lets a configured option render in ITS OWN colour rather than a
          // hashed one — the `Colors` list in `Edit property` writes this.
          options={property.config?.options as ConfiguredOption[] | undefined}
        />
      );
    case "status":
      return (
        <StatusCell
          value={value as StatusValue | undefined}
          editable={editable}
          onChange={onChange}
          // Lets a configured option render in ITS OWN colour rather than a
          // hashed one — the `Colors` list in `Edit property` writes this.
          options={property.config?.options as ConfiguredOption[] | undefined}
        />
      );
    case "date":
      return <DateCell value={value as DateValue | undefined} editable={editable} onChange={onChange} />;
    case "checkbox":
      return (
        <CheckboxCell
          value={value as CheckboxValue | undefined}
          editable={editable}
          onChange={onChange}
        />
      );
    case "relation":
      if (!relation) return <GenericCell value={value as UnknownValue | undefined} />;
      return (
        <RelationCell
          property={property}
          editable={editable}
          links={relation.links}
          onEnsureLoaded={relation.onEnsureLoaded}
          onLinksChange={relation.onLinksChange}
        />
      );
    // M2b. These three share rich_text's wire shape but not its cell: a URL
    // is a link, an email opens a mail client, a phone dials. Routed here
    // rather than to GenericCell, which is read-only — without this they
    // would be columns you could create and never fill.
    case "url":
    case "email":
    case "phone_number":
      return (
        <TextLikeCell
          kind={property.type as "url" | "email" | "phone_number"}
          value={value as UrlValue | EmailValue | PhoneValue | undefined}
          editable={editable}
          onChange={onChange}
        />
      );
    case "button":
      if (!button) return <GenericCell value={value as UnknownValue | undefined} />;
      return <ButtonCell property={property} noteId={button.noteId} editable={editable} />;
    case "formula":
    case "rollup":
      // Milestone 8 (task-28-brief.md §4): always read-only, regardless of
      // `editable` — there is exactly one legal writer of a computed value
      // (services/db/recompute.py), so `editable`/`onChange` are simply not
      // meaningful here, unlike every CellProps<V>-based cell above.
      return <FormulaCell property={property} value={value} />;
    default:
      return <GenericCell value={value as UnknownValue | undefined} />;
  }
}
