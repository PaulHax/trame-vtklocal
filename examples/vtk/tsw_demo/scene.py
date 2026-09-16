"""TSW's VTK feature combinations in a small, replaceable scene."""

import math

import numpy as np
import vtk
from vtkmodules.util.numpy_support import numpy_to_vtk

from trame_vtklocal import PointCloudSource, StreamedSceneActor, Tiles3DSource
from trame_vtklocal.module.interaction import make_pickable
from trame_vtklocal.module.point_cloud_presentation import mark_point_cloud_presentation
from trame_vtklocal.module.projected_texture import (
    mark_projected_texture,
    set_projected_texture_matrix,
)
from trame_vtklocal.module.screen_size_glyphs import mark_screen_size_glyphs

from .fixtures import IDENTITY


def polydata(coordinates):
    points = vtk.vtkPoints()
    points.SetData(numpy_to_vtk(np.asarray(coordinates, dtype=np.float32), deep=True))
    data = vtk.vtkPolyData()
    data.SetPoints(points)
    return data


def actor_for(mapper, color=(1, 1, 1)):
    actor = vtk.vtkActor()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(*color)
    actor.GetProperty().LightingOff()
    return actor


class DemoScene:
    def __init__(self, cloud_count):
        self.frame = 0
        self.generation = 0
        self.attached = True
        self.actors = {}
        self.cloud_data = polydata(
            [
                (x / 8 - 12, y / 8 - 4, math.sin(x / 5) / 2)
                for x in range(64)
                for y in range(64)
            ]
        )
        self.cloud_mapper = vtk.vtkPointGaussianMapper()
        self.cloud_mapper.SetInputData(self.cloud_data)
        self.cloud_mapper.EmissiveOff()
        self.cloud_mapper.SetScaleFactor(0)
        mark_point_cloud_presentation(self.cloud_mapper, diameter_css_px=3)
        self.actors["direct"] = actor_for(self.cloud_mapper, (0.95, 0.75, 0.2))
        self.stream = StreamedSceneActor(
            PointCloudSource(
                "demo-cloud",
                "v1",
                "/tsw-assets/cloud",
                cloud_count,
                presentation={"mode": "fixed", "diameterCssPx": 4},
                adaptive=True,
            )
        )
        self.stream_transform = vtk.vtkTransform()
        self.stream_transform.Translate(8, 0, 1)
        self.stream.SetUserTransform(self.stream_transform)
        self.actors["stream"] = self.stream
        self.mesh = StreamedSceneActor(
            Tiles3DSource(
                "demo-mesh",
                "v1",
                "/tsw-assets/mesh",
                IDENTITY,
                maximum_screen_space_error_px=8,
            )
        )
        self.mesh_transform = vtk.vtkTransform()
        self.mesh_transform.Translate(-8, 7, 1)
        self.mesh.SetUserTransform(self.mesh_transform)
        self.actors["mesh"] = self.mesh
        self.glyph_data = polydata([(-7, 0, 2), (0, 0, 2), (7, 0, 2)])
        source = vtk.vtkSphereSource()
        source.SetRadius(0.5)
        source.SetThetaResolution(12)
        source.SetPhiResolution(8)
        self.glyph_mapper = vtk.vtkGlyph3DMapper()
        self.glyph_mapper.SetInputData(self.glyph_data)
        self.glyph_mapper.SetSourceConnection(source.GetOutputPort())
        self.glyph_mapper.ScalarVisibilityOff()
        self.glyph_mapper.OrientOff()
        mark_screen_size_glyphs(self.glyph_mapper, 16)
        self.actors["landmarks"] = actor_for(self.glyph_mapper, (1, 0.2, 0.3))
        self.tag_landmarks()
        # Feedback is scene geometry so the independent inset confirms its depth.
        self.pick_data = polydata([(0, 0, 0)])
        pick_mapper = vtk.vtkGlyph3DMapper()
        pick_mapper.SetInputData(self.pick_data)
        pick_mapper.SetSourceConnection(source.GetOutputPort())
        pick_mapper.ScalarVisibilityOff()
        pick_mapper.OrientOff()
        mark_screen_size_glyphs(pick_mapper, 12)
        self.actors["pick-marker"] = actor_for(pick_mapper, (1, 1, 1))
        self.actors["pick-marker"].PickableOff()
        self.actors["pick-marker"].VisibilityOff()
        orbit_source = vtk.vtkSphereSource()
        orbit_source.SetRadius(0.8)
        orbit_source.SetThetaResolution(24)
        orbit_source.SetPhiResolution(16)
        orbit_mapper = vtk.vtkPolyDataMapper()
        orbit_mapper.SetInputConnection(orbit_source.GetOutputPort())
        self.actors["orbit"] = actor_for(orbit_mapper, (0.1, 0.6, 1))
        self.actors["orbit"].SetPosition(*self.orbit_position())
        self.trail_data = polydata([self.orbit_position()] * 120)
        lines = vtk.vtkCellArray()
        lines.InsertNextCell(120, list(range(120)))
        self.trail_data.SetLines(lines)
        trail_mapper = vtk.vtkPolyDataMapper()
        trail_mapper.SetInputData(self.trail_data)
        self.actors["trail"] = actor_for(trail_mapper, (0.1, 0.6, 1))
        self.transform = vtk.vtkTransform()
        self.planes = []
        for index, mode in enumerate(("homography", "worldToClip")):
            data = polydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)])
            cells = vtk.vtkCellArray()
            cells.InsertNextCell(4, [0, 1, 2, 3])
            data.SetPolys(cells)
            mapper = vtk.vtkPolyDataMapper()
            mapper.SetInputData(data)
            mark_projected_texture(mapper, "demo-video", mode=mode)
            if index == 0:
                set_projected_texture_matrix(
                    mapper, homography=[1, 0, 0, 0, 1, 0, 0, 0, 1]
                )
            else:
                set_projected_texture_matrix(
                    mapper,
                    world_to_clip=[2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1],
                )
            actor = actor_for(mapper)
            actor.SetScale(5, 5, 1)
            actor.SetPosition(-6 + index * 7, -10, 0)
            self.planes.append((data, mapper, actor))
            self.actors[f"projection-{mode}"] = actor
        self.source = vtk.vtkConeSource()
        self.source.SetResolution(16)
        self.source.SetHeight(4)
        self.source.SetRadius(2)
        self.pipeline_mapper = vtk.vtkPolyDataMapper()
        self.pipeline_mapper.SetInputConnection(self.source.GetOutputPort())
        self.actors["pipeline"] = actor_for(self.pipeline_mapper, (0.4, 1, 0.4))
        self.actors["pipeline"].SetPosition(0, 6, 3)
        self.actors["pipeline"].SetUserTransform(self.transform)
        self.windows = []
        self.renderers = []
        for _ in range(2):
            window = vtk.vtkRenderWindow()
            window.SetOffScreenRendering(1)
            window.SetSize(700, 500)
            window.SetNumberOfLayers(3)
            layers = []
            # TSW adds annotations first for camera/picking authority.
            for layer in (2, 1, 0):
                renderer = vtk.vtkRenderer()
                renderer.SetLayer(layer)
                renderer.SetBackground(0, 0, 0)
                renderer.SetBackgroundAlpha(0)
                renderer.PreserveColorBufferOn()
                renderer.SetPreserveDepthBuffer(layer == 1)
                window.AddRenderer(renderer)
                layers.append(renderer)
            annotations, video, world = layers
            for name, actor in self.actors.items():
                target = (
                    annotations
                    if name in ("landmarks", "pick-marker")
                    else (video if name.startswith("projection-") else world)
                )
                target.AddActor(actor)
            camera = annotations.GetActiveCamera()
            camera.SetPosition(0, -38, 46)
            camera.SetFocalPoint(0, 0, 0)
            camera.SetViewUp(0, 0, 1)
            for renderer in layers:
                renderer.SetActiveCamera(camera)
            self.windows.append(window)
            self.renderers.append(world)

    def orbit_position(self):
        angle = self.frame * math.pi / 100
        return (16 * math.cos(angle), 12 * math.sin(angle), 4)

    def show_pick(self, world):
        self.actors["pick-marker"].SetVisibility(world is not None)
        if world is not None:
            self.pick_data.GetPoints().SetPoint(0, *world)
            self.pick_data.GetPoints().Modified()

    def tag_landmarks(self):
        make_pickable(
            self.glyph_mapper,
            tags={"owner": "demo", "generation": self.generation},
            ids=["left", "middle", "right"],
            grab_px=24,
            preview="plane",
            plane={"origin": [0, 0, 2], "normal": [0, 0, 1]},
        )

    def advance(self):
        self.frame += 1
        self.actors["orbit"].SetPosition(*self.orbit_position())
        points = self.trail_data.GetPoints()
        for index in range(119):
            points.SetPoint(index, *points.GetPoint(index + 1))
        points.SetPoint(119, *self.orbit_position())
        points.Modified()
        # Only one point changes out of 4096: subsequent ticks should patch bytes.
        x, y, _ = self.cloud_data.GetPoint(200)
        self.cloud_data.GetPoints().SetPoint(200, x, y, 0.5 + math.sin(self.frame / 4))
        self.cloud_data.GetPoints().Modified()
        self.source.SetHeight(3 + math.sin(self.frame / 8))
        self.transform.Identity()
        self.transform.Translate(math.sin(self.frame / 8), 0, 0)
        self.planes[0][2].SetPosition(-6 + math.sin(self.frame / 10), -10, 0)

    def replace(self):
        self.generation += 1
        points = vtk.vtkPoints()
        points.DeepCopy(self.cloud_data.GetPoints())
        self.cloud_data.SetPoints(points)
        prop = vtk.vtkProperty()
        prop.SetColor(0.7, 0.4, 1)
        prop.LightingOff()
        self.actors["direct"].SetProperty(prop)
        self.transform = vtk.vtkTransform()
        self.actors["pipeline"].SetUserTransform(self.transform)
        self.source = vtk.vtkConeSource()
        self.source.SetResolution(20)
        self.source.SetRadius(2)
        self.pipeline_mapper.SetInputConnection(self.source.GetOutputPort())
        self.tag_landmarks()

    def toggle_membership(self):
        self.attached = not self.attached
        for renderer in self.renderers:
            method = renderer.AddActor if self.attached else renderer.RemoveActor
            for key in ("direct", "stream", "mesh", "pipeline"):
                method(self.actors[key])

    def toggle_opacity(self):
        for key in ("direct", "stream", "mesh"):
            prop = self.actors[key].GetProperty()
            prop.SetOpacity(0.4 if prop.GetOpacity() > 0.5 else 1)

    def correct(self):
        self.stream_transform.Translate(0, 1, 0)
        self.mesh_transform.Translate(0, 1, 0)
