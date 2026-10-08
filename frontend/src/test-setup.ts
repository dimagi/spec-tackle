import "@testing-library/jest-dom/vitest";

// jsdom doesn't lay anything out; give ranges an empty box like an off-screen element.
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
