extends SceneTree

func _initialize() -> void:
    var request_path := ""
    var response_path := ""
    var args := OS.get_cmdline_user_args()
    for index in range(args.size()):
        if args[index] == "--request" and index + 1 < args.size():
            request_path = args[index + 1]
        elif args[index] == "--response" and index + 1 < args.size():
            response_path = args[index + 1]

    if request_path.is_empty() or response_path.is_empty():
        quit(2)
        return

    var response: Dictionary
    var request_file := FileAccess.open(request_path, FileAccess.READ)
    if request_file == null:
        response = {"ok": false, "error": "Unable to open bridge request"}
    else:
        var parsed = JSON.parse_string(request_file.get_as_text())
        if typeof(parsed) != TYPE_DICTIONARY:
            response = {"ok": false, "error": "Bridge request is not a JSON object"}
        else:
            response = _handle_request(parsed)

    var response_file := FileAccess.open(response_path, FileAccess.WRITE)
    if response_file == null:
        quit(3)
        return
    response_file.store_string(JSON.stringify(response))
    quit(0)

func _handle_request(request: Dictionary) -> Dictionary:
    var scene_path := str(request.get("scene_path", ""))
    var resource := ResourceLoader.load(scene_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
    if resource == null or not resource is PackedScene:
        return {"ok": false, "error": "Unable to load PackedScene: %s" % scene_path}
    var packed := resource as PackedScene
    var root := packed.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED)
    if root == null:
        return {"ok": false, "error": "Unable to instantiate scene without a SceneTree"}
    var layer_path := str(request.get("layer_path", ""))
    var candidate: Node = root if root is TileMapLayer and (layer_path.is_empty() or layer_path == root.name) else root.get_node_or_null(NodePath(layer_path))
    if candidate == null or not candidate is TileMapLayer:
        root.free()
        return {"ok": false, "error": "TileMapLayer not found: %s" % layer_path}
    var layer := candidate as TileMapLayer

    var action := str(request.get("action", ""))
    var response: Dictionary
    if action == "apply_terrain":
        response = _apply_terrain(layer, request)
    elif action == "map_positions":
        response = _map_positions(layer, request)
    else:
        response = {"ok": false, "error": "Unknown bridge action: %s" % action}
    root.free()
    return response

func _apply_terrain(layer: TileMapLayer, request: Dictionary) -> Dictionary:
    var encoded := str(request.get("tile_map_data", ""))
    layer.set_tile_map_data_from_array(Marshalls.base64_to_raw(encoded) if not encoded.is_empty() else PackedByteArray())
    var points: Array[Vector2i] = []
    for raw_point in request.get("points", []):
        points.append(Vector2i(int(raw_point.get("x", 0)), int(raw_point.get("y", 0))))
    var terrain_set := int(request.get("terrain_set", 0))
    var terrain := int(request.get("terrain", 0))
    var ignore_empty := bool(request.get("ignore_empty_terrains", true))
    if request.get("operation", "") == "terrain_path":
        layer.set_cells_terrain_path(points, terrain_set, terrain, ignore_empty)
    else:
        layer.set_cells_terrain_connect(points, terrain_set, terrain, ignore_empty)
    var cells: Array[Dictionary] = []
    for position in layer.get_used_cells():
        cells.append({
            "x": position.x,
            "y": position.y,
            "source_id": layer.get_cell_source_id(position),
            "atlas_x": layer.get_cell_atlas_coords(position).x,
            "atlas_y": layer.get_cell_atlas_coords(position).y,
            "alternative_id": layer.get_cell_alternative_tile(position),
        })
    return {"ok": true, "cells": cells}

func _map_positions(layer: TileMapLayer, request: Dictionary) -> Dictionary:
    var positions: Array[Dictionary] = []
    for raw_point in request.get("points", []):
        var map_position := Vector2i(int(raw_point.get("x", 0)), int(raw_point.get("y", 0)))
        var local := layer.map_to_local(map_position)
        positions.append({
            "x": map_position.x,
            "y": map_position.y,
            "local_x": local.x,
            "local_y": local.y,
        })
    return {"ok": true, "positions": positions}
