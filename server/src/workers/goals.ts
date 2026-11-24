import type { Hmn } from "../hmn";
import type { Access } from "../types";
import type { Visible } from "./context";

export type GoalDraft = {
  sourceId: string;
  title: string;
  reason: string;
  summary: string;
  area_id: string | null;
  goalId: string;
};

/** A goal with no active project serving it, and no open task about it, gets one next step. */
export function goalDrafts(hmn: Hmn, access: Access, graph: Visible[]): GoalDraft[] {
  const byId = new Map(graph.map((item) => [item.id, item]));
  const drafts: GoalDraft[] = [];
  for (const goal of graph) {
    if (goal.type !== "goal" || goal.status !== "active") continue;
    const links = hmn.linksOf(access, "goal", goal.id);
    const served = links.some((link) => {
      if (link.rel !== "serves" || link.peer.type !== "project") return false;
      const project = byId.get(link.peer.id);
      return project?.status === "active";
    });
    const openTask = links.some((link) => {
      if (link.rel !== "about" || link.peer.type !== "task") return false;
      const task = byId.get(link.peer.id);
      return task?.status === "open" || task?.status === "inbox";
    });
    if (served || openTask) continue;
    const title = goal.title.trim().slice(0, 160);
    if (!title) continue;
    drafts.push({
      sourceId: goal.id,
      title: `Next step for ${title}`.slice(0, 200),
      reason: "This goal has no active project or task.",
      summary: "Goals",
      area_id: goal.area_id,
      goalId: goal.id,
    });
  }
  return drafts;
}
