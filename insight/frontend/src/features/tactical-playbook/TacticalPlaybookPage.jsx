import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PanelLeft, Plus, Upload } from "lucide-react";
import API from "../../api/api";
import { useT } from "../../i18n/useT";
import FolderTree from "./FolderTree";
import PlaybookFilters from "./PlaybookFilters";
import TacticList from "./TacticList";
import PlaybookDialog from "./PlaybookDialog";
import { filterTactics, folderIds, folderPath } from "./libraryModel";
import "./playbookLibrary.css";

const errorText = (error) => typeof error?.response?.data?.detail === "string" ? error.response.data.detail : error.message;
export default function TacticalPlaybookPage() {
  const t = useT(), navigate = useNavigate(), { folderId } = useParams();
  const [params, setParams] = useSearchParams();
  const [tree, setTree] = useState({ folders: [], tactics: [] });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(null), [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const fileRef = useRef(null);
  const filterKeys = ["search", "map", "side", "pov", "category", "site", "utility", "result", "sort"];
  const filters = Object.fromEntries(filterKeys.map((key) => [key, params.get(key) || (key === "sort" ? "updated" : "")]));
  const refresh = useCallback(async () => { const { data } = await API.get("/tactical/playbooks"); setTree(data); }, []);
  useEffect(() => {
    let active = true;
    API.get("/tactical/playbooks").then(({ data }) => { if (active) setTree(data); }).catch((err) => { if (active) setError(errorText(err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!tree.tactics.some((item) => item.pov_status === "generating")) return;
    const interval = setInterval(() => refresh().catch((err) => setError(errorText(err))), 3000);
    return () => clearInterval(interval);
  }, [tree.tactics, refresh]);
  const change = (key, value) => setParams((old) => { const next = new URLSearchParams(old); value ? next.set(key, value) : next.delete(key); return next; }, { replace: true });
  const select = (id) => navigate({ pathname: id ? `/tactics/folder/${id}` : "/tactics", search: params.toString() });
  const selectedFolder = tree.folders.find((item) => item.id === folderId);
  const visible = filterTactics(tree.tactics, { ...filters, folder: folderId });
  const open = (id) => navigate(`/tactics/${id}`);
  const run = async (operation) => { setError(""); try { await operation(); await refresh(); } catch (err) { setError(errorText(err)); } };
  const exportTactic = async (item) => {
    const { data } = await API.get(`/tactical/tactics/${item.id}`);
    const blob = new Blob([JSON.stringify({ format: "cs2-tactic-v1", tactic: data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${item.name.replace(/[<>:"/\\|?*]/g, "_")}.tactic.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const action = (key, item) => {
    if (key === "open") return open(item.id);
    if (key === "export" || key === "share") return void run(() => exportTactic(item));
    if (key === "removeFromFolder") return void run(() => API.put(`/tactical/tactics/${item.id}/folders`, { folder_ids: folderIds(item).filter((id) => id !== folderId) }));
    if (key === "duplicate") return void run(async () => {
      const { data } = await API.get(`/tactical/tactics/${item.id}`);
      await API.post("/tactical/import", { format: "cs2-tactic-v1", tactic: { ...data, name: `${data.name} (${t("playbook.copy")})` } });
    });
    setDialog({ kind: "tactics", action: key, item });
  };
  const submit = async ({ name, selected, parent, classification }) => {
    setBusy(true);
    try {
      const { kind, action: key, item } = dialog;
      if (["newFolder", "newSubfolder"].includes(key)) await API.post("/tactical/folders", { name, parent_id: key === "newSubfolder" ? item.id : null });
      else if (key === "rename") await API.patch(`/tactical/${kind}/${item.id}/name`, { name });
      else if (key === "classify") await API.patch(`/tactical/tactics/${item.id}/classification`, classification);
      else if (key === "move") await API.patch(`/tactical/folders/${item.id}/parent`, { parent_id: parent });
      else if (key === "addToFolder") await API.put(`/tactical/tactics/${item.id}/folders`, { folder_ids: selected });
      else if (key === "delete") await API.delete(`/tactical/${kind}/${item.id}`);
      await refresh();
      if (kind === "folders" && key === "delete") select(null);
      setDialog(null);
    } catch (err) { setDialog((old) => ({ ...old, error: errorText(err) })); }
    finally { setBusy(false); }
  };
  return <div className={`playbook-library ${collapsed ? "folders-collapsed" : ""}`} data-testid="tactical-library">
    {!collapsed && <FolderTree folders={tree.folders} selected={folderId} map={filters.map} total={tree.tactics.length} select={select} selectMap={(value) => { const next = new URLSearchParams(params); value ? next.set("map", value) : next.delete("map"); navigate({ pathname: "/tactics", search: next.toString() }); }} action={(key, item) => setDialog({ kind: "folders", action: key, item })} />}
    <main className="playbook-main">
      <header className="playbook-header"><button aria-label={t("playbook.toggleFolders")} onClick={() => setCollapsed(!collapsed)}><PanelLeft size={18} /></button><div><h1>{selectedFolder ? folderPath(selectedFolder, tree.folders) : t("playbook.all")}</h1><p>{t("playbook.count", { count: visible.length })}</p></div><span className="playbook-spacer" /><button onClick={() => setDialog({ kind: "folders", action: "newFolder" })}><Plus size={15} />{t("playbook.newFolder")}</button><button onClick={() => fileRef.current?.click()}><Upload size={15} />{t("playbook.import")}</button><Link className="playbook-primary" to="/tactics/new">{t("playbook.fromDemo")}</Link></header>
      <input hidden ref={fileRef} type="file" accept=".json" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void run(async () => { if (file.size > 25 * 1024 * 1024) throw new Error(t("playbook.fileTooLarge")); await API.post("/tactical/import", JSON.parse(await file.text())); }); }} />
      <PlaybookFilters filters={filters} change={change} />
      {error && <div className="playbook-error" role="alert">{error}<button onClick={() => void run(refresh)}>{t("playbook.retry")}</button></div>}
      {folderId && !selectedFolder && !loading ? <div className="playbook-empty"><p>{t("playbook.folderMissing")}</p><button onClick={() => select(null)}>{t("playbook.all")}</button></div>
        : loading ? <div className="playbook-empty" role="status">{t("playbook.loading")}</div>
        : visible.length ? <TacticList tactics={visible} inFolder={!!folderId} open={open} action={action} />
        : <div className="playbook-empty"><h2>{t(tree.tactics.length ? "playbook.noResults" : "playbook.noTactics")}</h2><p>{t(folderId ? "playbook.emptyFolder" : tree.tactics.length ? "playbook.filterHint" : "playbook.emptyHint")}</p>{folderId ? <div><button onClick={() => select(null)}>{t("playbook.addFromAll")}</button><button onClick={() => setDialog({ kind: "folders", action: "newSubfolder", item: selectedFolder })}>{t("playbook.newSubfolder")}</button></div> : <Link to="/analysis">{t("playbook.goAnalysis")}</Link>}</div>}
    </main>
    {dialog && <PlaybookDialog key={`${dialog.action}-${dialog.item?.id}`} dialog={dialog} folders={tree.folders} busy={busy} close={() => setDialog(null)} submit={submit} />}
  </div>;
}
