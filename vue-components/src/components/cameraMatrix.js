// One place owns the vtk.js camera matrix convention.
//
// vtk.js getCompositeProjectionMatrix returns its 16 floats in the transposed
// layout relative to what the flat project/unproject math in pickables.js and
// dragPreview.js reads (w picked up from indices 3/7/11/15). Every consumer
// converts through here so a projection path and an unprojection path can
// never disagree about the layout again.

export function transposeMatrix(matrix) {
  return [
    matrix[0],
    matrix[4],
    matrix[8],
    matrix[12],
    matrix[1],
    matrix[5],
    matrix[9],
    matrix[13],
    matrix[2],
    matrix[6],
    matrix[10],
    matrix[14],
    matrix[3],
    matrix[7],
    matrix[11],
    matrix[15],
  ];
}

// World->clip for what the camera actually renders, in the layout the shared
// project/unproject math reads, or null when unavailable.
// getCompositeProjectionMatrix already folds in user projection matrices and
// physicalScale, so consumers follow the actual rendered transform (including
// lock zoom/pan).
export function getWorldToClipMatrix(camera, aspect) {
  const matrix = camera?.getCompositeProjectionMatrix?.(aspect, -1, 1);
  if (!matrix || matrix.length !== 16) {
    return null;
  }
  return transposeMatrix(matrix);
}

export default { transposeMatrix, getWorldToClipMatrix };
