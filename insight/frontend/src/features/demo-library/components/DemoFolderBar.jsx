import { useState } from "react";
import { Folder, FolderPlus, Pencil, Trash2 } from "lucide-react";
import Button from "../../../components/ui/Button.jsx";
import Modal from "../../../components/ui/Modal.jsx";
import { useT } from "../../../i18n/useT.js";

const fieldClass = "h-8 min-w-0 rounded-md border border-cs2-border bg-cs2-bg-input px-2.5 text-[11px] text-cs2-text-primary outline-none focus:border-cs2-accent/60";
const smallButtonClass = "inline-flex h-7 items-center gap-1 rounded border border-cs2-border px-2 text-[10px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/40 hover:text-cs2-text-primary disabled:cursor-not-allowed disabled:opacity-40";

export default function DemoFolderBar({
  folders = [],
  unfiledCount = 0,
  activeScope = "all",
  selectedCount = 0,
  busy = false,
  onScopeChange,
  onMoveSelected,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}) {
  const t = useT();
  const [manageOpen, setManageOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");
  const [deleteId, setDeleteId] = useState(null);
  const [moveTarget, setMoveTarget] = useState("");

  const createFolder = async (event) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name || busy) return;
    const created = await onCreateFolder?.(name);
    if (created) setDraft("");
  };

  const saveRename = async (event) => {
    event.preventDefault();
    const name = editingName.trim();
    if (!name || busy || editingId == null) return;
    const saved = await onRenameFolder?.(editingId, name);
    if (saved) {
      setEditingId(null);
      setEditingName("");
    }
  };

  const selectScope = (scope) => {
    setMoveTarget("");
    onScopeChange?.(scope);
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-cs2-border bg-cs2-bg-card px-2.5 py-2">
      <nav aria-label={t("library.foldersLabel")} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <button
          type="button"
          aria-pressed={activeScope === "all"}
          onClick={() => selectScope("all")}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] font-semibold transition-colors ${activeScope === "all" ? "border-cs2-accent/45 bg-cs2-accent/10 text-cs2-accent" : "border-transparent text-cs2-text-muted hover:border-cs2-border hover:text-cs2-text-primary"}`}
        >
          <Folder className="h-3 w-3" />{t("library.foldersAll")}
        </button>
        <button
          type="button"
          aria-pressed={activeScope === "unfiled"}
          onClick={() => selectScope("unfiled")}
          className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] font-semibold transition-colors ${activeScope === "unfiled" ? "border-cs2-accent/45 bg-cs2-accent/10 text-cs2-accent" : "border-transparent text-cs2-text-muted hover:border-cs2-border hover:text-cs2-text-primary"}`}
        >
          <Folder className="h-3 w-3" />{t("library.foldersUnfiled")}
          <span className="text-[9px] opacity-65">{unfiledCount}</span>
        </button>
        {folders.map((folder) => {
          const scope = String(folder.id);
          const active = activeScope === scope;
          return (
            <button
              key={folder.id}
              type="button"
              aria-pressed={active}
              onClick={() => selectScope(scope)}
              className={`inline-flex h-7 max-w-48 items-center gap-1.5 rounded-md border px-2.5 text-[10px] font-semibold transition-colors ${active ? "border-cs2-accent/45 bg-cs2-accent/10 text-cs2-accent" : "border-transparent text-cs2-text-muted hover:border-cs2-border hover:text-cs2-text-primary"}`}
              title={folder.name}
            >
              <Folder className="h-3 w-3 shrink-0" />
              <span className="truncate">{folder.name}</span>
              <span className="shrink-0 text-[9px] opacity-65">{folder.demo_count}</span>
            </button>
          );
        })}
      </nav>

      {selectedCount > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-l border-cs2-border pl-2">
          <span className="text-[10px] text-cs2-text-muted">{t("library.folderMoveCount", { count: selectedCount })}</span>
          <select
            aria-label={t("library.folderMoveTarget")}
            value={moveTarget}
            onChange={(event) => setMoveTarget(event.target.value)}
            className="h-7 max-w-40 rounded border border-cs2-border bg-cs2-bg-input px-2 text-[10px] text-cs2-text-secondary outline-none focus:border-cs2-accent/50"
          >
            <option value="">{t("library.folderMoveTarget")}</option>
            <option value="unfiled">{t("library.foldersUnfiled")}</option>
            {folders.map((folder) => <option key={folder.id} value={String(folder.id)}>{folder.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!moveTarget || busy}
            onClick={async () => {
              const moved = await onMoveSelected?.(moveTarget);
              if (moved) setMoveTarget("");
            }}
            className={smallButtonClass}
          >
            {t("library.folderMove")}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setManageOpen(true)}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-cs2-border px-2.5 text-[10px] font-semibold text-cs2-text-secondary transition-colors hover:border-cs2-accent/40 hover:text-cs2-accent"
      >
        <FolderPlus className="h-3 w-3" />{t("library.folderManage")}
      </button>

      <Modal
        open={manageOpen}
        onClose={() => { setManageOpen(false); setEditingId(null); setDeleteId(null); }}
        title={t("library.folderManage")}
        maxWidth="max-w-lg"
        maxHeight="max-h-[75vh]"
        className="!h-auto"
      >
        <div className="space-y-4 px-4 py-4">
          <form onSubmit={(event) => void createFolder(event)} className="flex gap-2">
            <input
              aria-label={t("library.folderName")}
              className={`${fieldClass} flex-1`}
              value={draft}
              maxLength={64}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("library.folderNamePlaceholder")}
            />
            <Button type="submit" size="sm" disabled={!draft.trim() || busy}>
              <FolderPlus className="mr-1.5 h-3.5 w-3.5" />{t("library.folderCreate")}
            </Button>
          </form>
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-cs2-text-muted">{t("library.folderListTitle")}</p>
            {folders.length ? folders.map((folder) => (
              <div key={folder.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-cs2-border/70 bg-cs2-bg-input/40 px-2.5 py-2">
                {editingId === folder.id ? (
                  <form onSubmit={(event) => void saveRename(event)} className="flex min-w-0 flex-1 gap-1.5">
                    <input
                      aria-label={t("library.folderName")}
                      className={`${fieldClass} flex-1`}
                      value={editingName}
                      maxLength={64}
                      onChange={(event) => setEditingName(event.target.value)}
                      autoFocus
                    />
                    <button type="submit" disabled={!editingName.trim() || busy} className={smallButtonClass}>{t("common.save")}</button>
                    <button type="button" onClick={() => setEditingId(null)} className={smallButtonClass}>{t("common.cancel")}</button>
                  </form>
                ) : (
                  <>
                    <Folder className="h-3.5 w-3.5 shrink-0 text-cs2-accent" />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-cs2-text-primary">{folder.name}</span>
                    <span className="text-[10px] text-cs2-text-muted">{folder.demo_count}</span>
                    <button
                      type="button"
                      disabled={busy}
                      title={t("library.folderRename")}
                      onClick={() => { setEditingId(folder.id); setEditingName(folder.name); setDeleteId(null); }}
                      className={smallButtonClass}
                    ><Pencil className="h-3 w-3" />{t("library.folderRename")}</button>
                    {deleteId === folder.id ? (
                      <>
                        <button type="button" disabled={busy} onClick={async () => { const ok = await onDeleteFolder?.(folder.id); if (ok) setDeleteId(null); }} className={`${smallButtonClass} !border-red-500/50 !text-cs2-red-on-surface`}>{t("common.confirm")}</button>
                        <button type="button" disabled={busy} onClick={() => setDeleteId(null)} className={smallButtonClass}>{t("common.cancel")}</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        title={t("library.folderDelete")}
                        onClick={() => { setDeleteId(folder.id); setEditingId(null); }}
                        className={`${smallButtonClass} hover:!border-red-500/40 hover:!text-cs2-red-on-surface`}
                      ><Trash2 className="h-3 w-3" />{t("library.folderDelete")}</button>
                    )}
                  </>
                )}
              </div>
            )) : (
              <p className="rounded-md border border-dashed border-cs2-border px-3 py-5 text-center text-[11px] text-cs2-text-muted">{t("library.folderListEmpty")}</p>
            )}
          </div>
          <p className="text-[10px] leading-relaxed text-cs2-text-muted">{t("library.folderDeleteHint")}</p>
        </div>
      </Modal>
    </div>
  );
}
