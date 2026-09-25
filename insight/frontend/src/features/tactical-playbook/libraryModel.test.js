import { describe, expect, it } from "vitest";
import { descendants, filterTactics, folderPath } from "./libraryModel";
const tactics = [
  { id: "a", name: "Spirit A Split", map_name: "de_mirage", side: "T", round_number: 17, folder_ids: ["training", "other"], metadata: { source_match: "Spirit vs Vitality", tags: ["execute"] } },
  { id: "b", name: "Hold B", map_name: "de_nuke", side: "CT", round_number: 2, folder_ids: [], metadata: {} },
];
describe("library filters", () => {
  it("combines search, map and side inside the current collection without copying entities", () => {
    expect(filterTactics(tactics, { folder: "training", search: "Spirit R17", map: "de_mirage", side: "T" })).toEqual([tactics[0]]);
    expect(filterTactics(tactics, { folder: "training", side: "CT" })).toEqual([]);
    expect(filterTactics(tactics, { search: "execute" })).toEqual([tactics[0]]);
    expect(filterTactics(tactics, {})).toHaveLength(2);
  });
  it("resolves nested paths and excludes the full descendant set from moves", () => {
    const folders = [{ id: "a", name: "Training" }, { id: "b", name: "Mirage", parent_id: "a" }, { id: "c", name: "A", parent_id: "b" }];
    expect(folderPath(folders[2], folders)).toBe("Training / Mirage / A");
    expect([...descendants("a", folders)]).toEqual(["a", "b", "c"]);
  });
});
