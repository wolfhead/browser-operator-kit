export function screenPointFromPageGeometry(geometry, zoomFactor = 1) {
  const point = geometry?.viewportPoint;
  const screen = geometry?.screen;
  const zoom = Number(zoomFactor);
  const values = [
    point?.x,
    point?.y,
    screen?.x,
    screen?.y,
    screen?.outerWidth,
    screen?.outerHeight,
    screen?.innerWidth,
    screen?.innerHeight,
    zoom
  ].map(Number);
  if (values.some((value) => !Number.isFinite(value)) || zoom <= 0) {
    throw new Error("Native input geometry is incomplete or invalid.");
  }
  const horizontalChromeDifference = Math.max(screen.outerWidth - screen.innerWidth * zoom, 0);
  const horizontalInset = Math.min(horizontalChromeDifference / 2, 16);
  const verticalInset = Math.max(screen.outerHeight - screen.innerHeight * zoom, 0);
  return {
    x: Math.round((screen.x + horizontalInset + point.x * zoom) * 100) / 100,
    y: Math.round((screen.y + verticalInset + point.y * zoom) * 100) / 100
  };
}
