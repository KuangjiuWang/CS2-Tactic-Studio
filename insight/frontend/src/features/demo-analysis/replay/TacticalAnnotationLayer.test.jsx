import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import TacticalAnnotationLayer from "./TacticalAnnotationLayer";

it("stores structured map-relative points for a drawn route", () => {
  const onCommit = vi.fn();
  render(<TacticalAnnotationLayer mode="line" color="#38bdf8" onCommit={onCommit} />);
  const svg = screen.getByTestId("tactical-annotations");
  svg.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
  fireEvent(svg, new MouseEvent("pointerdown", { bubbles: true, clientX: 30, clientY: 40 }));
  fireEvent(svg, new MouseEvent("pointermove", { bubbles: true, clientX: 110, clientY: 70 }));
  fireEvent(svg, new MouseEvent("pointerup", { bubbles: true, clientX: 110, clientY: 70 }));
  expect(onCommit).toHaveBeenCalledWith(expect.objectContaining({
    type: "line", color: "#38bdf8", points: [{ x: 10, y: 20 }, { x: 50, y: 50 }],
  }));
});
