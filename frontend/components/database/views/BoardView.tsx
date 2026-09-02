"use client";

// Kanban-style board: one column per Group (task-15's query endpoint has
// already computed the grouping — this component never re-derives it
// client-side), each card a differently-laid-out read/write view of the
// same DatabaseRow.properties TableView already knows how to render (see
// cells/renderCellValue.tsx — the same dispatcher, not a second one).
//
// Drag-and-drop follows components/sidebar/NoteTree.tsx's DndContext/
// onDragEnd structural pattern (sensors, activationConstraint distance,
// onDragEnd), but with useDraggable/useDroppable rather than
// SortableContext/useSortable — NoteTree reorders within one list, a Board
// moves cards *between* columns, a different drag shape dnd-kit models
// with plain draggable/droppable pairs instead.
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DatabaseRow, Group, MultiSelectValue, PropertyResponse, PropertyValue } from "@/lib/database/types";
import { getHiddenKeys, orderProperties } from "@/lib/database/viewConfig";
import { useRowPeek } from "@/lib/database/useRowPeek";
import { renderCellValue } from "../cells/renderCellValue";
import { OpenNoteButton } from "../OpenNoteButton";
import { RowPeek } from "../RowPeek";

// Mirrors services.db.query.grouping._NO_VALUE_KEY exactly — the implicit
// bucket every grouped type gets for rows with no value on the grouped
// property. Dropping a card here clears the property rather than setting
// it to the literal string "__no_value__".
const NO_VALUE_KEY = "__no_value__";

const COLUMN_DROPPABLE_PREFIX = "column:";

interface BoardViewProps {
  properties: PropertyResponse[];
  /** `null` while the query for a configured board hasn't resolved yet, or
   * when there's no `groupPropertyKey` at all (see the placeholder below). */
  groups: Group[] | null;
  /** `config.group_by.property_key`, or `null` if the view has none
   * configured — task-16-brief.md's deliberate deviation from Notion: this
   * app never auto-creates a status property to fill the gap, it asks the
   * user to pick an existing groupable property when creating the view
   * (see ViewTabs.tsx). */
  groupPropertyKey: string | null;
  hideEmptyGroups: boolean;
  onToggleHideEmptyGroups: (value: boolean) => void;
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  /** M12: `useRowPeek`'s own read of the view's "Open pages in" default —
   * previously only `TableView`/`ListView`/`FeedView` respected this;
   * Board's `OpenNoteButton` always hard-navigated regardless of it. */
  config?: Record<string, unknown>;
  dataSourceId?: string;
  refetch?: () => void | Promise<void>;
}

interface DragData {
  rowId: string;
  sourceGroupKey: string;
}

/** Pure drag-drop resolution, deliberately separated from dnd-kit's
 * onDragEnd so the trickiest part of this task — multi_select "add the tag"
 * vs. every other type's "replace the value" — can be unit tested directly
 * against plain data, without simulating pointer events through dnd-kit's
 * sensors.
 *
 * Returns `undefined` for "nothing to write" (dropped back in its own
 * column, or a multi_select card dropped on a tag it already has — no
 * duplicate), `null` for "clear the property" (dropped on the implicit "No
 * value" column), or the new PropertyValue to write otherwise.
 *
 * multi_select is genuinely different from every other groupable type:
 * its value is a list, so "this card's group changed" (single-valued:
 * select/status — replace) is not the same operation as "one more tag was
 * added" (multi-valued: multi_select — append, keep the rest). Getting
 * this wrong silently deletes a card's other tags on every drag — see
 * task-16-brief.md's explicit warning and the "ADDS the tag, preserving
 * existing tags" test above. */
export function resolveDropValue(
  payload: DragData,
  targetGroupKey: string,
  groupProperty: PropertyResponse,
  groups: Group[]
): PropertyValue | null | undefined {
  if (payload.sourceGroupKey === targetGroupKey) return undefined;

  if (groupProperty.type === "multi_select") {
    const row = groups.flatMap((g) => g.rows).find((r) => r.id === payload.rowId);
    const current = (row?.properties[groupProperty.key] as MultiSelectValue | undefined)?.multi_select ?? [];
    if (targetGroupKey === NO_VALUE_KEY) {
      return { type: "multi_select", multi_select: [] };
    }
    if (current.includes(targetGroupKey)) return undefined;
    return { type: "multi_select", multi_select: [...current, targetGroupKey] };
  }

  if (targetGroupKey === NO_VALUE_KEY) return null;
  return { type: groupProperty.type, [groupProperty.type]: targetGroupKey } as PropertyValue;
}

/** The dnd-kit draggable id for one card *instance*. Exported and
 * unit-tested directly (task-17 fix round, finding 2) because the
 * uniqueness guarantee it exists for can't be observed from outside
 * dnd-kit's internal registry without simulating a real drag — proof by
 * construction is the only practical way to pin it.
 *
 * `sourceGroupKey` alone already disambiguates a multi_select-grouped
 * top-level card that appears in more than one column (one instance per
 * tag it has — the original reason this function exists). Sub-grouping by
 * a multi_select property (no UI to configure that yet, but the grouping
 * engine and BoardColumn's rendering both already support it) introduces a
 * second axis: the *same* row can appear in two different sub-buckets of
 * the *same* top-level column, where `sourceGroupKey` is identical for
 * both — so `subgroupKey` has to be part of the id too, or the second
 * registration silently overwrites dnd-kit's record of the first (last
 * mount wins), and a drag started from the first card's DOM node would
 * resolve against the second card's data. `subgroupKey` is `undefined` for
 * a top-level (non-sub-grouped) card; normalized to `""` here so the id
 * shape is uniform either way. */
export function cardDraggableId(sourceGroupKey: string, subgroupKey: string | undefined, rowId: string): string {
  return `card:${sourceGroupKey}:${subgroupKey ?? ""}:${rowId}`;
}

function BoardCard({
  row,
  properties,
  otherProps,
  editable,
  onCellChange,
  sourceGroupKey,
  subgroupKey,
  onOpenRow,
  isPeekOpen,
}: {
  row: DatabaseRow;
  properties: PropertyResponse[];
  /** M12: precomputed by `BoardView` via `viewConfig.ts`'s
   * `orderProperties`/`getHiddenKeys` — the SAME hidden/ordered list Table's
   * `orderedProperties` and List's own already-built read use, closing the
   * identical "Property Visibility panel writes hidden_properties/
   * property_order, nothing here ever read either" gap Table itself had
   * before M3's own review checkpoint fixed it once. Not derived from
   * `properties` locally anymore — every card must agree on the same order/
   * visibility, not re-sort itself. */
  otherProps: PropertyResponse[];
  editable: boolean;
  onCellChange: BoardViewProps["onCellChange"];
  sourceGroupKey: string;
  /** Only set when this card instance is rendered inside a sub-group (see
   * `cardDraggableId` above) — never part of the drag *data* (that stays
   * `sourceGroupKey`-only, matching what `resolveDropValue`/`handleDragEnd`
   * expect), only the draggable *id*. */
  subgroupKey?: string;
  /** M12: `useRowPeek`'s own `openRow`/`peekRowId` — threaded down instead
   * of a bare `useOpenNote` navigation, so a Board card respects the
   * view's "Open pages in" default the same way Table/List/Feed already do. */
  onOpenRow?: (noteId: string) => void;
  isPeekOpen?: boolean;
}) {
  // id must be unique per (row, column[, sub-bucket]) instance, not just
  // per row — a multi_select-grouped card can appear in more than one
  // column (once per tag), and dnd-kit requires unique draggable ids
  // within one DndContext.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: cardDraggableId(sourceGroupKey, subgroupKey, row.id),
    data: { rowId: row.id, sourceGroupKey } satisfies DragData,
  });

  const titleProp = properties.find((p) => p.type === "title");

  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`relative rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 mb-2 shadow-sm cursor-grab active:cursor-grabbing touch-none ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <OpenNoteButton
        noteId={row.id}
        className="absolute top-1 right-1"
        onOpen={onOpenRow}
        isOpen={onOpenRow ? isPeekOpen : undefined}
      />
      {titleProp && (
        <div className="text-sm font-medium mb-1 pr-5 text-gray-900 dark:text-gray-100">
          {renderCellValue(titleProp, row.properties[titleProp.key], editable, (value) =>
            onCellChange(row.id, titleProp.key, value)
          )}
        </div>
      )}
      <div className="space-y-1">
        {otherProps.map((p) => (
          <div key={p.key} className="text-xs flex items-start gap-1">
            <span className="text-gray-400 shrink-0">{p.name}:</span>
            <span className="min-w-0 flex-1">
              {renderCellValue(p, row.properties[p.key], editable, (value) => onCellChange(row.id, p.key, value))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Structural subset of dnd-kit's real `DragEndEvent` — just the fields
 * `computeDragEndWrite` actually reads. A real `DragEndEvent` has more
 * fields (`activatorEvent`, `collisions`, `delta`, `active.rect`, ...) and
 * is structurally assignable here without a cast; `data.current` stays
 * loosely typed (dnd-kit's own `AnyData = Record<string, any>`, same as
 * the real `Active.data` field) and is narrowed to `DragData` inside the
 * function body, same as `handleDragEnd` did before this was extracted. */
interface DragEndEventLike {
  over: { id: string | number } | null;
  active: { data: { current?: Record<string, unknown> } };
}

/** The "wiring" between a real dnd-kit drag-end event and `resolveDropValue`
 * above: parses the `column:` droppable-id prefix, reads
 * `active.data.current`, and returns the write to make — or `undefined` for
 * every no-op case (dropped outside a column droppable, no `groups`/
 * `groupProperty` resolved yet, no drag data attached, or `resolveDropValue`
 * itself decided there's nothing to write).
 *
 * Exported and unit-tested directly against a hand-built event-shaped
 * object (task-17 fix round, finding 4) — same reasoning as
 * `resolveDropValue`: this doesn't need real dnd-kit pointer-event
 * simulation to verify, only a plain object matching the shape this
 * function actually reads. Previously this logic lived inline inside
 * `handleDragEnd` below with no coverage of its own (only the
 * `resolveDropValue` call inside it was tested). */
export function computeDragEndWrite(
  event: DragEndEventLike,
  groupProperty: PropertyResponse | undefined,
  groups: Group[] | null
): { rowId: string; value: PropertyValue | null } | undefined {
  const { active, over } = event;
  if (!over || !groupProperty || !groups) return undefined;
  const overId = String(over.id);
  if (!overId.startsWith(COLUMN_DROPPABLE_PREFIX)) return undefined;
  const targetGroupKey = overId.slice(COLUMN_DROPPABLE_PREFIX.length);

  const data = active.data.current as DragData | undefined;
  if (!data) return undefined;

  const value = resolveDropValue(data, targetGroupKey, groupProperty, groups);
  if (value === undefined) return undefined; // no-op drop
  return { rowId: data.rowId, value };
}

function BoardColumn({
  group,
  properties,
  otherProps,
  editable,
  onCellChange,
  onOpenRow,
  peekRowId,
}: {
  group: Group;
  properties: PropertyResponse[];
  otherProps: PropertyResponse[];
  editable: boolean;
  onCellChange: BoardViewProps["onCellChange"];
  onOpenRow?: (noteId: string) => void;
  peekRowId?: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_DROPPABLE_PREFIX}${group.key}` });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col w-72 shrink-0 rounded-lg bg-gray-50 dark:bg-gray-900/50 p-2 ${
        isOver ? "ring-2 ring-indigo-400" : ""
      }`}
    >
      <div className="flex items-center gap-2 px-1 py-1 mb-1">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{group.label}</span>
        <span className="text-xs text-gray-400">{group.row_count}</span>
      </div>

      {group.subgroups ? (
        // Sub-grouping is a visual nesting only — every card here still
        // drags against this column's own droppable above, never a
        // sub-group-specific one (research §G.4.2 doesn't document
        // cross-sub-group drag semantics; task-16-brief.md: "don't invent
        // them").
        group.subgroups.map((sub) => (
          <div key={sub.key} className="mb-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400 px-1 mb-1">
              {sub.label} · {sub.row_count}
            </div>
            {sub.rows.map((row) => (
              <BoardCard
                key={row.id}
                row={row}
                properties={properties}
                otherProps={otherProps}
                editable={editable}
                onCellChange={onCellChange}
                sourceGroupKey={group.key}
                subgroupKey={sub.key}
                onOpenRow={onOpenRow}
                isPeekOpen={peekRowId === row.id}
              />
            ))}
          </div>
        ))
      ) : (
        group.rows.map((row) => (
          <BoardCard
            key={row.id}
            row={row}
            properties={properties}
            otherProps={otherProps}
            editable={editable}
            onCellChange={onCellChange}
            sourceGroupKey={group.key}
            onOpenRow={onOpenRow}
            isPeekOpen={peekRowId === row.id}
          />
        ))
      )}
    </div>
  );
}

export function BoardView({
  properties,
  groups,
  groupPropertyKey,
  hideEmptyGroups,
  onToggleHideEmptyGroups,
  editable,
  onCellChange,
  config = {},
  dataSourceId,
  refetch,
}: BoardViewProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Same 5px activation constraint as NoteTree.tsx — prevents an
      // ordinary click (e.g. editing a cell inside the card) from being
      // swallowed as a drag.
      activationConstraint: { distance: 5 },
    })
  );
  // M12: called unconditionally, before the `!groupPropertyKey` early
  // return below (hooks can't follow a conditional return) — an ungrouped
  // Board still needs `openRow` to work once a card exists via some other
  // path, and the rule against conditional hooks applies regardless.
  const { peekRowId, peekMode, openRow, closePeek } = useRowPeek(config);

  // task-16-brief.md's deliberate deviation from Notion (which
  // auto-mutates the schema to invent a status property): this app
  // requires an existing groupable property, chosen at view-creation time
  // (ViewTabs.tsx). If a Board view somehow has none configured, show that
  // plainly instead of crashing or silently rendering nothing.
  if (!groupPropertyKey) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500 text-center px-6">
        no groupable property yet — add a Select, Status, or Multi-select property first
      </div>
    );
  }

  const groupProperty = properties.find((p) => p.key === groupPropertyKey);
  // Re-bind to a new const: TS's control-flow narrowing from the early
  // `if (!groupPropertyKey) return` above doesn't carry into the separate
  // `handleDragEnd` closure below, since the value could in principle
  // change before that closure runs — a fresh const captures the already-
  // narrowed `string` type once and for all.
  const resolvedGroupPropertyKey: string = groupPropertyKey;

  function handleDragEnd(event: DragEndEvent) {
    const result = computeDragEndWrite(event, groupProperty, groups);
    if (!result) return;
    onCellChange(result.rowId, resolvedGroupPropertyKey, result.value);
  }

  // M12: the same hidden/ordered read Table's `orderedProperties` and
  // List's own build already use — Board's cards used to always show every
  // non-title property, in schema order, regardless of what the Property
  // Visibility panel wrote (a silent no-op, same class as the M1-era Table
  // bug M3's review checkpoint already fixed once).
  const hiddenKeys = new Set(getHiddenKeys(config));
  const otherProps = orderProperties(properties, config).filter(
    (p) => p.type !== "title" && !hiddenKeys.has(p.key)
  );

  // Board has no flat `rows` prop — `groups`/`subgroups` are the only place
  // a row lives, so the peek's own row lookup has to walk both levels.
  const peekRow = peekRowId
    ? (groups ?? [])
        .flatMap((g) => g.subgroups?.flatMap((sg) => sg.rows) ?? g.rows)
        .find((r) => r.id === peekRowId)
    : undefined;

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-100 dark:border-gray-800 shrink-0">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={hideEmptyGroups}
            onChange={(e) => onToggleHideEmptyGroups(e.target.checked)}
          />
          Hide empty groups
        </label>
      </div>

      {groups === null ? (
        <div className="flex items-center justify-center flex-1 text-sm text-gray-400 dark:text-gray-500">
          Loading…
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <div className="flex-1 min-h-0 overflow-auto flex gap-3 p-3">
            {groups.map((group) => (
              <BoardColumn
                key={group.key}
                group={group}
                properties={properties}
                otherProps={otherProps}
                editable={editable}
                onCellChange={onCellChange}
                onOpenRow={openRow}
                peekRowId={peekRowId}
              />
            ))}
          </div>
        </DndContext>
      )}

      {peekRow && (
        <RowPeek
          row={peekRow}
          properties={properties}
          editable={editable}
          onCellChange={onCellChange}
          onClose={closePeek}
          mode={peekMode === "center" ? "center" : "side"}
          dataSourceId={dataSourceId}
          onPropertyCreated={refetch}
        />
      )}
    </div>
  );
}
