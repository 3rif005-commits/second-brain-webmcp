"use client";

// Shell around a database: title bar, view tabs (+ creation), and a
// switch over the active view's `type` that renders the matching view
// component. Was hardcoded to `views[0]` + TableView only (Milestone 2);
// task-16 adds real view switching/creation and the Board view.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/app/providers";
import { useDatabaseView } from "@/lib/database/useDatabaseView";
import { useWebMcpTools } from "@/lib/webmcp/useWebMcpTools";
import { buildDatabaseTools } from "@/lib/webmcp/tools/database";
import type { ViewResponse } from "@/lib/database/types";
import { defaultGroupBySpec, getGroupBySpec, getSubGroupBySpec, getSubtaskDisplayMode } from "@/lib/database/types";
import type { GroupBySpec } from "@/lib/database/types";
import type { Sort, SortsUpdater } from "@/lib/database/viewConfig";
import { asFilterNode } from "@/lib/database/filterAst";
import type { FilterUpdater } from "./FilterBuilder";
import type { GroupByUpdater } from "./GroupBuilder";
import { TableView } from "./views/TableView";
import { BoardView } from "./views/BoardView";
import { GalleryView } from "./views/GalleryView";
import { ListView } from "./views/ListView";
import { FeedView } from "./views/FeedView";
import { CalendarView } from "./views/CalendarView";
import { TimelineView } from "./views/TimelineView";
import { ChartView } from "./views/ChartView";
import { FormView } from "./views/FormView";
import { DashboardView } from "./views/DashboardView";
import { ViewTabs } from "./ViewTabs";
import { DatabaseHeader } from "./DatabaseHeader";
import { ViewToolbar } from "./ViewToolbar";
import { ViewSettingsSidebar } from "./ViewSettingsSidebar";
import { DatabaseSettingsMenu } from "./DatabaseSettingsMenu";

interface DatabaseShellProps {
  databaseId: string;
}

export function DatabaseShell({ databaseId }: DatabaseShellProps) {
  const {
    database,
    dataSource,
    properties,
    views,
    activeViewId,
    setActiveViewId,
    rows,
    groups,
    aggregates,
    loading,
    error,
    updateCell,
    relationLinks,
    ensureRelationLinks,
    ensureRelationLinksBulk,
    setRelationLinks,
    createView,
    updateView,
    deleteView,
    updateDatabase,
    deleteDatabase,
    templates,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    instantiateTemplate,
    automations,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    refetch,
    refetchRows,
  } = useDatabaseView(databaseId);
  const { showToast } = useToast();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // view-tab-bar.md's Persistence table: "The active view is already in the
  // URL as ?view=<viewId> — Notion does this and so should we." Copy link
  // to view (ViewTabs.tsx's copyViewLink) has written this since M7; nothing
  // read it back until now (M3/M7's own recorded gap). `page.tsx` already
  // wraps this component in <Suspense> (confirmed before relying on that,
  // same discipline M10's identical `useSearchParams` addition to
  // TableView.tsx used) so `useSearchParams` is safe here.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Applies the URL's view id AT MOST ONCE, the first render `views` is
  // non-empty — a ref guard, not a dependency-array trick, because this
  // must NOT re-fire every time `activeViewId` itself changes (that would
  // fight `selectView` below on every ordinary tab switch). Only overrides
  // the hook's own "keep current tab, else first view" default
  // (useDatabaseView.ts's `load`) when the param actually names one of
  // THIS database's views — a stale or foreign id is silently ignored,
  // same as `?p=`'s row-peek precedent.
  const appliedViewParamRef = useRef(false);
  useEffect(() => {
    if (appliedViewParamRef.current || views.length === 0) return;
    appliedViewParamRef.current = true;
    const fromUrl = searchParams.get("view");
    if (fromUrl && fromUrl !== activeViewId && views.some((v) => v.id === fromUrl)) {
      setActiveViewId(fromUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views]);

  // The one place `activeViewId` changes in response to a user action
  // (switching tabs, a fresh view's own post-create select, duplicate,
  // delete's fall-back-to-remaining) writes the URL too, preserving every
  // other param (`?p=`/`?pm=` included — TableView.tsx's own writePeekUrl
  // does the same in reverse) — router.replace, not push, matching row
  // peek's identical "not a distinct navigable page" reasoning.
  function selectView(viewId: string) {
    setActiveViewId(viewId);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", viewId);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  // WebMCP: expose this database as tools for whatever agent is present —
  // the browser's, or our own side panel. The tool set is generated from
  // THIS database's live schema (see lib/webmcp/tools/database.ts) and is
  // scoped to this component, so navigating to another database swaps the
  // whole surface and fires `toolchange` rather than leaving stale tools
  // registered. `selectView` rather than the raw `setActiveViewId` so an
  // agent switching views updates the URL exactly as a click would.
  useWebMcpTools(
    dataSource && database ? `database:${databaseId}` : null,
    () =>
      dataSource && database
        ? buildDatabaseTools({
            databaseName: database.title || "Untitled database",
            dataSourceId: dataSource.id,
            properties,
            views,
            activeView: views.find((v) => v.id === activeViewId),
            activeViewId,
            rows,
            groups,
            setActiveViewId: selectView,
            updateCell,
            updateView,
            refetchRows,
          })
        : []
  );

  // Live-discovered fix (post-M13-review, controller-added): every
  // config-driven view below (Gallery/Feed/Calendar/Timeline/Form) used to
  // build its `onConfigChange` PATCH by merging onto `activeView.config`
  // captured from THIS render's closure — `(patch) => updateView(activeView.id,
  // { config: { ...activeView.config, ...patch } })`. Two structural
  // config changes fired close together (before React re-renders with the
  // first PATCH's response) both read the SAME stale `activeView.config`,
  // so the second request's merge silently drops whatever the first one
  // changed once its own response landed — caught live while click-testing
  // FormView.tsx: toggling "Required" then immediately toggling "Closed"
  // reverted "Required" back to false server-side, even though the UI
  // showed both as applied. `patchViewConfig` below fixes this for good by
  // tracking each view's LATEST known config in a ref (updated the instant
  // a PATCH response lands, not on next render) and chaining same-view
  // PATCHes sequentially, so each one always merges onto the true latest
  // state rather than a stale prop.
  const latestConfigByViewRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const pendingPatchByViewRef = useRef<Map<string, Promise<unknown>>>(new Map());
  const patchViewConfig = useCallback(
    (viewId: string, renderTimeConfig: Record<string, unknown>, patch: Record<string, unknown>) => {
      const prevQueue = pendingPatchByViewRef.current.get(viewId) ?? Promise.resolve();
      const nextQueue = prevQueue
        .catch(() => undefined)
        .then(async () => {
          // `base` is resolved HERE, not synchronously at call time — a
          // first bugged version of this fix computed it eagerly (reading
          // `latestConfigByViewRef` before the queue's own prior entry had
          // actually resolved and populated it), which meant a second
          // rapid call still silently fell back to the stale
          // `renderTimeConfig` exactly like the original bug. Reading the
          // ref HERE, inside the `.then()` that only runs once the
          // previous same-view PATCH has resolved, is what actually
          // guarantees freshness — caught by this file's own regression
          // test for this exact scenario before it shipped.
          const base = latestConfigByViewRef.current.get(viewId) ?? renderTimeConfig;
          const merged = { ...base, ...patch };
          let updated: ViewResponse;
          try {
            updated = await updateView(viewId, { config: merged });
          } catch (err) {
            // Same "toast, don't throw to an unhandled rejection" convention
            // DashboardView.tsx's own saveRows already establishes for a
            // failed config PATCH — a caller here never awaits this queue's
            // result (onConfigChange is fire-and-forget from every view's
            // own perspective), so an uncaught rejection here would
            // otherwise vanish silently instead of telling the user their
            // change didn't save.
            showToast(err instanceof Error ? err.message : "Could not save that change", "error");
            return undefined;
          }
          latestConfigByViewRef.current.set(viewId, updated.config);
          return updated;
        })
        .finally(() => {
          if (pendingPatchByViewRef.current.get(viewId) === nextQueue) {
            pendingPatchByViewRef.current.delete(viewId);
          }
        });
      pendingPatchByViewRef.current.set(viewId, nextQueue);
      return nextQueue;
    },
    [updateView]
  );

  // Same staleness bug `patchViewConfig` above exists for, one field over.
  // Review-checkpoint finding (M1-M3 pass): M3 gave `sorts` a SECOND and
  // THIRD writer (the toolbar's Sort popover, the settings sidebar's Sort
  // panel) alongside M1's column header menu — all three can now be open at
  // once, each computing its next `sorts` array from a `sorts` closed over
  // at ITS OWN last render. `sorts` is a whole-array REPLACE, not a
  // mergeable object like `config`, so simply queuing the two PATCH
  // REQUESTS wouldn't fix this — whichever request's ALREADY-STALE array
  // lands last still wins outright. The caller must defer computing the new
  // array until its turn in the queue, against the LATEST known `sorts` —
  // exactly `patchViewConfig`'s own fix, generalized to an updater function
  // instead of a patch object because there is nothing to merge.
  const latestSortsByViewRef = useRef<Map<string, unknown[]>>(new Map());
  const queueSortsUpdate = useCallback(
    (viewId: string, renderTimeSorts: unknown[], updater: SortsUpdater) => {
      const prevQueue = pendingPatchByViewRef.current.get(viewId) ?? Promise.resolve();
      const nextQueue = prevQueue
        .catch(() => undefined)
        .then(async () => {
          const base = (latestSortsByViewRef.current.get(viewId) ?? renderTimeSorts) as Sort[];
          const next = updater(base);
          let updated: ViewResponse;
          try {
            updated = await updateView(viewId, { sorts: next });
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Could not sort", "error");
            return undefined;
          }
          latestSortsByViewRef.current.set(viewId, updated.sorts);
          return updated;
        })
        .finally(() => {
          if (pendingPatchByViewRef.current.get(viewId) === nextQueue) {
            pendingPatchByViewRef.current.delete(viewId);
          }
        });
      // Shares `pendingPatchByViewRef` with `patchViewConfig` above, not a
      // second queue — a config write and a sorts write for the SAME view
      // are serialized against each other too, not just against their own kind.
      pendingPatchByViewRef.current.set(viewId, nextQueue);
      return nextQueue;
    },
    [updateView, showToast]
  );

  // Same hazard as `sorts`, one field over again — M4 flags it explicitly
  // (filter-panel.md: "Two rapid filter edits must not lose the first").
  // `filter` is also a separate `ViewPatch` field from `config` (whole-value
  // REPLACE, not mergeable), reachable from the toolbar's Filter popover,
  // the settings sidebar's Filter row, and (once wired) a column header's
  // "Filter" row — three writers, same as `sorts`.
  const latestFilterByViewRef = useRef<Map<string, Record<string, unknown> | null>>(new Map());
  const queueFilterUpdate = useCallback(
    (viewId: string, renderTimeFilter: Record<string, unknown> | null, updater: FilterUpdater) => {
      const prevQueue = pendingPatchByViewRef.current.get(viewId) ?? Promise.resolve();
      const nextQueue = prevQueue
        .catch(() => undefined)
        .then(async () => {
          const base = latestFilterByViewRef.current.has(viewId)
            ? (latestFilterByViewRef.current.get(viewId) ?? null)
            : renderTimeFilter;
          const next = updater(asFilterNode(base));
          let updated: ViewResponse;
          try {
            updated = await updateView(viewId, { filter: next as Record<string, unknown> | null });
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Could not filter", "error");
            return undefined;
          }
          latestFilterByViewRef.current.set(viewId, updated.filter);
          return updated;
        })
        .finally(() => {
          if (pendingPatchByViewRef.current.get(viewId) === nextQueue) {
            pendingPatchByViewRef.current.delete(viewId);
          }
        });
      pendingPatchByViewRef.current.set(viewId, nextQueue);
      return nextQueue;
    },
    [updateView, showToast]
  );

  // `group_by` lives INSIDE `config` (unlike `sorts`/`filter`, their own top-
  // level `ViewPatch` fields) but has the identical "whole-value REPLACE,
  // needs the queue's own latest, not a stale render-time closure" hazard —
  // see `GroupByUpdater`'s own doc comment (GroupBuilder.tsx) for the exact
  // live-verified bug this fixes (`Hide all` + `Hide empty groups` fired
  // close together silently dropped the first). Shares `pendingPatchByViewRef`
  // AND `latestConfigByViewRef` with `patchViewConfig` above, not separate
  // refs — a group_by write and any OTHER config write (a layout toggle, the
  // column header menu's own `group_by` replace) for the SAME view stay
  // serialized against each other too, and both read/write the one true
  // latest `config`, not two divergent copies of it.
  const queueGroupByUpdate = useCallback(
    (viewId: string, renderTimeConfig: Record<string, unknown>, updater: GroupByUpdater) => {
      const prevQueue = pendingPatchByViewRef.current.get(viewId) ?? Promise.resolve();
      const nextQueue = prevQueue
        .catch(() => undefined)
        .then(async () => {
          const base = latestConfigByViewRef.current.get(viewId) ?? renderTimeConfig;
          const next = updater(base.group_by as GroupBySpec | undefined);
          const merged = { ...base, group_by: next };
          let updated: ViewResponse;
          try {
            updated = await updateView(viewId, { config: merged });
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Could not group", "error");
            return undefined;
          }
          latestConfigByViewRef.current.set(viewId, updated.config);
          return updated;
        })
        .finally(() => {
          if (pendingPatchByViewRef.current.get(viewId) === nextQueue) {
            pendingPatchByViewRef.current.delete(viewId);
          }
        });
      pendingPatchByViewRef.current.set(viewId, nextQueue);
      return nextQueue;
    },
    [updateView, showToast]
  );

  if (loading && !database) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
        Loading…
      </div>
    );
  }

  if (error && !database) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-red-500">
        {error}
      </div>
    );
  }

  if (!database || !dataSource) return null;

  const editable = !dataSource.is_virtual;
  const activeView = views.find((v) => v.id === activeViewId) ?? views[0] ?? null;
  // Captured as a plain string rather than reading `dataSource.id` inside
  // `renderActiveView` below: TS's control-flow narrowing from the
  // `!dataSource` check above doesn't cross into a nested function's body,
  // so `dataSource` would still type as possibly-null there.
  const dataSourceId = dataSource.id;
  const dataSourceName = dataSource.name;

  /** "+" (ViewTabs.tsx, view-tab-bar.md's create-first-configure-after
   * rewrite): create IMMEDIATELY with an empty name (so the tab falls back
   * to showing the view's TYPE — `viewTabLabel`) and no config, then
   * auto-select whatever this makes sense to pre-fill from the database's
   * OWN existing properties — mirroring live Notion's confirmed behaviour
   * ("a Board auto-selected an EXISTING Status property to group by") for
   * the case where an eligible property already exists, while keeping this
   * app's own deliberate refusal to *invent* one when none does (BoardView/
   * CalendarView/TimelineView's own placeholders handle that gap, each with
   * a real way to fix it afterward — Group panel for Board, an inline
   * picker for Calendar/Timeline, added alongside this rewrite). Opens the
   * settings sidebar afterward either way — "opens the view settings
   * sidebar for configuring afterward", the spec's own words.
   *
   * Live-verified regression this mirrors: `services.db.query.grouping.
   * GroupBySpec` has no implicit default `mode` for `status` (Milestone 4's
   * own "fail loud, don't guess" decision) — `defaultGroupBySpec` (types.ts,
   * Phase 0c) is the one place that's filled in, so the auto-selected Board
   * group-by below goes through it rather than a bare `{property_key}`. */
  async function handleCreateView(input: { type: string; chartConfig?: Record<string, unknown> }) {
    const created = await createView("", input.type);
    if (input.type === "board") {
      // Restricted to the three "kanban-native" types, NOT the full
      // `GROUPABLE_PROPERTY_TYPES` (which Phase 0c widened to 17 types —
      // Text/Number/Date/Person/etc. — for the Group panel and column
      // header's own "Group" row, surfaces where a broader set makes
      // sense). Live Notion's only observed auto-select picked an existing
      // Status property; defaulting a fresh Board to group by, say, its own
      // Title or a Created-time property would be a strange first
      // impression a real select-family property never risks. Falls
      // through to BoardView's own "no groupable property yet" placeholder
      // (which the user chose over auto-creating a Status property) when
      // none of the three exist yet, even if a wider-family property does.
      const groupProperty = properties
        .filter((p) => p.type === "select" || p.type === "status" || p.type === "multi_select")
        .sort((a, b) => a.position - b.position)[0];
      if (groupProperty) {
        await updateView(created.id, { config: { group_by: defaultGroupBySpec(groupProperty) } });
      }
    } else if (input.type === "calendar" || input.type === "timeline") {
      const dateProperty = properties
        .slice()
        .sort((a, b) => a.position - b.position)
        .find((p) => p.type === "date");
      if (dateProperty) {
        await updateView(created.id, { config: { date_property_id: dateProperty.key } });
      }
    } else if (input.type === "chart" && input.chartConfig) {
      await updateView(created.id, { config: input.chartConfig });
    }
    selectView(created.id);
    // Deferred one tick, same fix and same reason as ViewTabs.tsx's
    // `onEditView` (M7 live-checklist finding): the "+" popover this was
    // just clicked from (ViewTabs.tsx's AddViewGrid/Chart-step Popover) is
    // still finishing its own close/unmount in the same tick — opening this
    // SidePeek synchronously here raced it, and the popover's own dismissal
    // silently closed the sidebar right back (a Radix DismissableLayer
    // focus-transition conflict between two overlays alive at once, the
    // same class M7's bug was). Caught by DatabaseShell.test.tsx, not live
    // Chrome — the manual click-then-screenshot pacing there gave Radix
    // enough real wall-clock time to settle before each screenshot, so the
    // race never visibly manifested there the way it did deterministically
    // in jsdom.
    setTimeout(() => setSettingsOpen(true), 0);
  }

  function renderActiveView() {
    if (!activeView) return null;

    switch (activeView.type) {
      case "table":
        return (
          <TableView
            properties={properties}
            rows={rows}
            editable={editable}
            onCellChange={updateCell}
            dataSourceId={dataSourceId}
            refetch={refetch}
            refetchRows={refetchRows}
            relationLinks={relationLinks}
            ensureRelationLinks={ensureRelationLinks}
            ensureRelationLinksBulk={ensureRelationLinksBulk}
            setRelationLinks={setRelationLinks}
            subItemDisplayMode={getSubtaskDisplayMode(activeView.config)}
            templates={templates}
            onInstantiateTemplate={instantiateTemplate}
            // M11 (new-row-button.md): the split-button dropdown's "Templates
            // for <name>" header and its "+ New template" row, which reuses
            // DatabaseSettingsMenu.tsx's own TemplateManager handlers. The
            // spec's own header reads "Templates for <DATABASE name>" — pass
            // database.title, not the data source's own name (only ever
            // "Default" today, since create_database mints exactly one).
            dataSourceName={database?.title ?? dataSourceName}
            onCreateTemplate={createTemplate}
            onUpdateTemplate={updateTemplate}
            onDeleteTemplate={deleteTemplate}
            view={activeView}
            // Routed through patchViewConfig, not a fresh closure over
            // activeView.config: the header menu fires several config writes
            // in quick succession (hide, then wrap, then a calculation), which
            // is precisely the case the stale-merge bug fixed at :79-125 was
            // about.
            onPatchConfig={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
            // Routed through queueSortsUpdate for the same reason — the
            // column header menu, the toolbar's Sort popover and the
            // settings sidebar's Sort panel can all be reached in the same
            // session now, each computing its own next `sorts` array.
            onSetSorts={(updater) => queueSortsUpdate(activeView.id, activeView.sorts, updater)}
            // M4: routed through queueFilterUpdate for the identical reason.
            onSetFilter={(updater) => queueFilterUpdate(activeView.id, activeView.filter, updater)}
            // Routed through queueGroupByUpdate for the identical reason —
            // the column header menu's own "Group" row and the settings
            // sidebar's Group panel can both be reached in the same session.
            onSetGroupBy={(updater) => queueGroupByUpdate(activeView.id, activeView.config, updater)}
            // M6: populated (and `rows` emptied) by useDatabaseView.loadRows
            // whenever config.group_by is set — see getQueryExtras' new
            // "table" branch.
            groups={groups}
            // M11: populated the same way, whenever getQueryExtras' table
            // branch sent `aggregations` (some column has a calculation,
            // and the view isn't grouped).
            aggregates={aggregates}
          />
        );
      case "board": {
        const groupBy = getGroupBySpec(activeView.config);
        const subGroupBy = getSubGroupBySpec(activeView.config);
        return (
          <BoardView
            properties={properties}
            groups={groups}
            groupPropertyKey={groupBy?.property_key ?? null}
            hideEmptyGroups={groupBy?.hide_empty_groups ?? false}
            onToggleHideEmptyGroups={(value) =>
              updateView(activeView.id, {
                config: {
                  ...activeView.config,
                  group_by: { ...(groupBy ?? { property_key: "" }), hide_empty_groups: value },
                  ...(subGroupBy ? { sub_group_by: subGroupBy } : {}),
                },
              })
            }
            editable={editable}
            onCellChange={updateCell}
            config={activeView.config}
            dataSourceId={dataSourceId}
            refetch={refetch}
          />
        );
      }
      case "gallery":
        return (
          <GalleryView
            properties={properties}
            rows={rows}
            editable={editable}
            onCellChange={updateCell}
            config={activeView.config}
            onConfigChange={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
            dataSourceId={dataSourceId}
            refetch={refetch}
          />
        );
      case "list":
        return (
          <ListView
            properties={properties}
            rows={rows}
            editable={editable}
            onCellChange={updateCell}
            config={activeView.config}
            dataSourceId={dataSourceId}
            refetchRows={refetchRows}
            refetch={refetch}
          />
        );
      case "feed":
        return (
          <FeedView
            properties={properties}
            rows={rows}
            editable={editable}
            onCellChange={updateCell}
            config={activeView.config}
            onConfigChange={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
            dataSourceId={dataSourceId}
            refetch={refetch}
          />
        );
      case "calendar":
        return (
          <CalendarView
            properties={properties}
            rows={rows}
            editable={editable}
            onCellChange={updateCell}
            config={activeView.config}
            onConfigChange={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
            dataSourceId={dataSourceId}
            refetchRows={refetchRows}
            refetch={refetch}
          />
        );
      case "timeline":
        return (
          <TimelineView
            properties={properties}
            rows={rows}
            editable={editable}
            onCellChange={updateCell}
            config={activeView.config}
            onConfigChange={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
            relationLinks={relationLinks}
            ensureRelationLinksBulk={ensureRelationLinksBulk}
            dataSourceId={dataSourceId}
            refetch={refetch}
          />
        );
      case "chart":
        // Read-only for data (research §9.8: "you can't edit database
        // entries from chart view") — unlike every other case above, this
        // one does NOT thread through `editable`/`onCellChange` at all:
        // `editable` is forced `false` unconditionally (never the caller's
        // real All-Notes-vs-ordinary state), and `onCellChange` isn't
        // passed at all (ChartView's own prop is optional and, even when
        // supplied directly in its own tests, is never reachable from any
        // interaction — see ChartView.test.tsx).
        return (
          <ChartView
            properties={properties}
            config={activeView.config}
            groups={groups}
            aggregates={aggregates}
            editable={false}
          />
        );
      case "form":
        // Builder/editor, not a data grid (task-44-brief.md — Notion's own
        // Form view "has no `properties` array and cannot group/sort/filter
        // data", research §12) — no `rows`/`editable`/`onCellChange` threaded
        // through, same read-only-of-row-data spirit as Chart's own branch
        // above, just for a different reason (this one edits `config`, not
        // row data, at all).
        return (
          <FormView
            viewId={activeView.id}
            properties={properties}
            config={activeView.config}
            onConfigChange={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
          />
        );
      case "dashboard":
        // The only COMPOSITE view type (task-45-brief.md, research §13): it
        // renders OTHER views from this SAME data source in a 12-column
        // widget grid rather than row data itself, so — unlike every case
        // above — it needs the full `views` list (to resolve each widget's
        // `view_id`) rather than `rows`/`groups`/`aggregates` (each widget
        // fetches its own, independently of whatever this dashboard view's
        // own query state is — DashboardView.tsx's own top-of-file comment
        // explains why that's a separate fetch rather than reusing this
        // function's `rows`/`groups`/`aggregates` closure).
        //
        // `onUpdateView` is `updateView` itself, unwrapped — same pattern
        // `DatabaseSettingsMenu`'s own `onUpdateView` prop already uses a
        // few lines down — rather than a bespoke `onConfigChange` closure
        // like every other case above: DashboardView needs to PATCH BOTH
        // its own view (the widget grid) AND, per-widget, whichever OTHER
        // view a widget is displaying (e.g. a Board widget's "hide empty
        // groups" toggle), so a single `(patch) => updateView(activeView.id,
        // ...)` closure bound to just this view wouldn't be enough.
        return (
          <DashboardView
            viewId={activeView.id}
            dataSourceId={dataSourceId}
            properties={properties}
            views={views}
            config={activeView.config}
            editable={editable}
            onUpdateView={updateView}
          />
        );
      default:
        // Task-15's own spirit for view *config* ("tolerates unknown...
        // drops them at read"), applied to view *type* rendering — every
        // type this milestone ships (table/board/gallery/list/feed/
        // calendar/timeline/chart/form/dashboard) has a branch above;
        // anything else (a stale/unknown string) is a plain message, never
        // a crash or a blank screen. Map is explicitly out of scope for the
        // whole milestone (user decision) and falls through to this same
        // placeholder, same as any other unimplemented type string.
        return (
          <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">
            This view type isn&apos;t supported yet.
          </div>
        );
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
        <DatabaseHeader
          // Review-checkpoint finding (M7-M11 pass): the SAME class of bug
          // the M1-M3 checkpoint already fixed for `ViewNameHeader` —
          // `titleDraft`/`descriptionDraft` are `useState` INITIAL values,
          // never resynced from `database` on prop change. Sidebar.tsx
          // navigates between databases client-side (`router.push`, no
          // full reload), so switching from database A to B without this
          // key left the input showing A's OLD title/description over B's
          // real data — and blurring without editing would silently PATCH
          // B's title to A's stale one, since `commitTitle`'s own
          // `trimmed === database.title` guard was comparing against the
          // WRONG database. `key`, not an effect, matching the proven fix.
          key={database.id}
          database={database}
          dataSource={dataSource}
          editable={editable}
          onUpdate={updateDatabase}
          onDelete={deleteDatabase}
          // All Notes has no db_properties/db_views rows to configure at
          // all (it's synthesized from COLUMN_BACKED, routers/databases.py)
          // — hidden rather than shown-disabled, same "not merely disabled"
          // rule the relation controls follow.
          trailing={
            editable ? (
              <DatabaseSettingsMenu
                dataSourceId={dataSourceId}
                properties={properties}
                activeView={activeView}
                onPropertiesChanged={refetch}
                onUpdateView={updateView}
                templates={templates}
                onCreateTemplate={createTemplate}
                onUpdateTemplate={updateTemplate}
                onDeleteTemplate={deleteTemplate}
                automations={automations}
                onCreateAutomation={createAutomation}
                onUpdateAutomation={updateAutomation}
                onDeleteAutomation={deleteAutomation}
              />
            ) : undefined
          }
        />

        {/* view-tab-bar.md's own States table: "Read-only source (is_virtual):
         * All Notes has no db_views rows at all. Suppress the whole bar" —
         * live-checklist finding: this rendered the full bar anyway, menu
         * and all (Rename/Edit view/Duplicate view included), because only
         * `trailing` below was gated on `editable`. The tab's own `views[0]`
         * id (a synthesized `"all-notes-table"`, not a real `db_views` row —
         * see `routers/databases.py`'s `_all_notes_database`) is still what
         * `renderActiveView` below reads, so removing the BAR here doesn't
         * remove the view itself, only the now-dangerous tab-switcher UI
         * (its writes -- rename, duplicate, delete -- would PATCH/DELETE a
         * view id that doesn't exist in `db_views` and fail). */}
        {editable && (
          <ViewTabs
            views={views}
            activeViewId={activeView?.id ?? ""}
            onSelect={selectView}
            properties={properties}
            onCreateView={handleCreateView}
            onCreateViewRaw={createView}
            dataSourceName={dataSource.name}
            onUpdateView={updateView}
            onDeleteView={deleteView}
            onOpenSettings={() => setSettingsOpen(true)}
            trailing={
              activeView ? (
                <ViewToolbar
                  view={activeView}
                  properties={properties}
                  onSetSorts={(updater) => queueSortsUpdate(activeView.id, activeView.sorts, updater)}
                  onSetFilter={(updater) => queueFilterUpdate(activeView.id, activeView.filter, updater)}
                  dataSourceId={dataSourceId}
                  automations={automations}
                  onCreateAutomation={createAutomation}
                  onUpdateAutomation={updateAutomation}
                  onDeleteAutomation={deleteAutomation}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              ) : undefined
            }
          />
        )}
      </div>

      {/* Active view */}
      <div className="flex-1 min-h-0">{renderActiveView()}</div>

      {editable && activeView && (
        <ViewSettingsSidebar
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          view={activeView}
          properties={properties}
          database={database}
          dataSourceId={dataSourceId}
          dataSourceName={dataSource.name}
          onPatchConfig={(patch) => patchViewConfig(activeView.id, activeView.config, patch)}
          onUpdateView={(viewId, patch) => updateView(viewId, patch)}
          onPropertiesChanged={refetch}
          onDatabaseChanged={refetch}
          onSetSorts={(updater) => queueSortsUpdate(activeView.id, activeView.sorts, updater)}
          onSetFilter={(updater) => queueFilterUpdate(activeView.id, activeView.filter, updater)}
          onSetGroupBy={(updater) => queueGroupByUpdate(activeView.id, activeView.config, updater)}
          groups={groups}
          automations={automations}
          onCreateAutomation={createAutomation}
          onUpdateAutomation={updateAutomation}
          onDeleteAutomation={deleteAutomation}
        />
      )}
    </div>
  );
}
