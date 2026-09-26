import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import API from "../../api/api";
import { useLocaleStore } from "../../i18n/localeStore";
import TacticalPlaybookPage from "./TacticalPlaybookPage";

vi.mock("../../api/api", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
let tree;
beforeEach(() => {
  useLocaleStore.setState({ effectiveLocale: "en" });
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  tree = { folders: [{ id: "training", name: "Training", parent_id: null }, { id: "mirage", name: "Mirage", parent_id: "training" }], tactics: [
    { id: "spirit", name: "Spirit A Split", map_name: "de_mirage", side: "T", round_number: 17, folder_ids: [], metadata: { source_match: "Spirit vs Vitality" }, updated_at: "2026-09-25" },
    { id: "hold", name: "Hold B", map_name: "de_nuke", side: "CT", round_number: 4, folder_ids: [], metadata: {} },
  ] };
  vi.clearAllMocks();
  API.get.mockImplementation(async () => ({ data: structuredClone(tree) }));
  API.put.mockImplementation(async (url, body) => { tree.tactics.find((item) => url.includes(item.id)).folder_ids = body.folder_ids; return {}; });
});
function show(path = "/tactics") {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/tactics" element={<TacticalPlaybookPage />} /><Route path="/tactics/folder/:folderId" element={<TacticalPlaybookPage />} /><Route path="/tactics/:tacticId" element={<div>Viewer opened</div>} /></Routes></MemoryRouter>);
}
describe("Playbook library", () => {
  it("works without an analysis workspace and filters before opening a routed viewer", async () => {
    show();
    await screen.findByText("Spirit A Split");
    fireEvent.change(screen.getByLabelText("Search tactics..."), { target: { value: "Vitality" } });
    expect(screen.queryByText("Hold B")).toBeNull();
    fireEvent.change(screen.getByLabelText("Side"), { target: { value: "CT" } });
    expect(screen.queryByText("Spirit A Split")).toBeNull();
    fireEvent.change(screen.getByLabelText("Side"), { target: { value: "T" } });
    fireEvent.click(screen.getByText("Spirit A Split"));
    expect(screen.getByText("Viewer opened")).toBeTruthy();
  });
  it("adds one entity to nested folders and removes only the current membership", async () => {
    show();
    await screen.findByText("Spirit A Split");
    fireEvent.click(screen.getByLabelText("Actions Spirit A Split"));
    fireEvent.click(screen.getByText("Add to Folder"));
    fireEvent.click(screen.getByLabelText("Training / Mirage"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(API.put).toHaveBeenCalledWith("/tactical/tactics/spirit/folders", { folder_ids: ["mirage"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Mirage", exact: true }).at(-1));
    expect(screen.getByText("Spirit A Split")).toBeTruthy();
    expect(screen.queryByText("Hold B")).toBeNull();
    fireEvent.click(screen.getByLabelText("Actions Spirit A Split"));
    fireEvent.click(screen.getByText("Remove from Folder"));
    await waitFor(() => expect(screen.queryByText("Spirit A Split")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: /All Tactics/ })[0]);
    expect(screen.getByText("Spirit A Split")).toBeTruthy();
    expect(tree.tactics).toHaveLength(2);
    expect(API.delete).not.toHaveBeenCalled();
  });
  it("restores folder scope and filters from the URL", async () => {
    tree.tactics[0].folder_ids = ["mirage"];
    show("/tactics/folder/mirage?search=Spirit&map=de_mirage&side=T");
    await screen.findByText("Spirit A Split");
    expect(screen.getByLabelText("Search tactics...").value).toBe("Spirit");
    expect(screen.queryByText("Hold B")).toBeNull();
  });
  it("filters and edits tactical classification", async () => {
    tree.tactics[0].metadata.classification = { category: "execute", site: "A", utility: ["smoke"], result: "win", tags: ["fast"] };
    API.patch.mockImplementation(async (_url, classification) => {
      tree.tactics[0].metadata.classification = classification;
      return { data: tree.tactics[0] };
    });
    show();
    await screen.findByText("Spirit A Split");
    fireEvent.change(screen.getByLabelText("Tactic type"), { target: { value: "execute" } });
    fireEvent.change(screen.getByLabelText("Key utility"), { target: { value: "smoke" } });
    expect(screen.queryByText("Hold B")).toBeNull();

    fireEvent.click(screen.getByLabelText("Actions Spirit A Split"));
    fireEvent.click(screen.getByText("Edit classification"));
    const categorySelect = screen.getByRole("dialog").querySelector('select[aria-label="Tactic type"]');
    fireEvent.change(categorySelect, { target: { value: "clutch" } });
    expect(categorySelect.value).toBe("clutch");
    fireEvent.change(screen.getByLabelText("Custom tags"), { target: { value: "late retake, saved, SAVED" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(API.patch).toHaveBeenCalledWith("/tactical/tactics/spirit/classification", expect.objectContaining({
      category: "clutch", site: "A", utility: ["smoke"], result: "win", tags: ["late retake", "saved"],
    })));
  });
  it("prevents classification saves that exceed the backend tag limit", async () => {
    show();
    await screen.findByText("Spirit A Split");
    fireEvent.click(screen.getByLabelText("Actions Spirit A Split"));
    fireEvent.click(screen.getByText("Edit classification"));
    fireEvent.change(screen.getByLabelText("Custom tags"), {
      target: { value: Array.from({ length: 21 }, (_, index) => `tag-${index}`).join(", ") },
    });
    expect(screen.getByRole("alert").textContent).toContain("20 unique tags");
    expect(screen.getByRole("button", { name: "Confirm" }).disabled).toBe(true);
    expect(API.patch).not.toHaveBeenCalled();
  });
});
