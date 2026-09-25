import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useT } from "../../i18n/useT";
import { mapLabel } from "./libraryModel";

export default function TacticList({ tactics, inFolder, open, action }) {
  const t = useT();
  const [menu, setMenu] = useState(null);
  return <div className="playbook-table-scroll"><table className="playbook-table"><thead><tr>{["side", "map", "name", "round", "pov", "updated", "actions"].map((key) => <th key={key}>{t(`playbook.${key}`)}</th>)}</tr></thead><tbody>
    {tactics.map((item) => <tr key={item.id} tabIndex={0} onClick={() => open(item.id)} onKeyDown={(e) => { if (e.target === e.currentTarget && ["Enter", " "].includes(e.key)) { e.preventDefault(); open(item.id); } }} onContextMenu={(e) => { e.preventDefault(); setMenu(item.id); }}>
      <td><span className={`playbook-side side-${item.side.toLowerCase()}`}>● {item.side}</span></td><td>{mapLabel(item.map_name)}</td>
      <td className="playbook-name"><strong>{item.name}</strong><small>{item.metadata?.source_match || item.source_demo_path?.split(/[\\/]/).pop() || "—"}</small></td>
      <td>R{item.round_number}</td><td className={`playbook-pov pov-${item.pov_status}`}>{item.pov_status === "ready" ? "5 POV" : item.pov_status === "partial" ? `${item.pov_count} / 5 POV` : item.pov_status === "generating" ? `${t("playbook.generating")} ${item.pov_count} / 5` : t(`playbook.${item.pov_status || "none"}`)}</td>
      <td><time title={item.updated_at}>{item.updated_at?.slice(0, 10)}</time></td><td className="playbook-row-menu" onClick={(e) => e.stopPropagation()}>
        <button aria-label={`${t("playbook.actions")} ${item.name}`} onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreHorizontal size={18} /></button>
        {menu === item.id && <div className="playbook-menu" onKeyDown={(e) => { if (e.key === "Escape") setMenu(null); }}>{["open", "addToFolder", ...(inFolder ? ["removeFromFolder"] : []), "rename", "duplicate", "export", "share", "delete"].map((key) => <button key={key} onClick={() => { setMenu(null); action(key, item); }}>{t(`playbook.${key}`)}</button>)}</div>}
      </td>
    </tr>)}
  </tbody></table></div>;
}
