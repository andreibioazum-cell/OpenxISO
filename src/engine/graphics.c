/* Рендерер игры: Vulkan на Android, Canvas 2D на вебе (через web_main.c). */
#ifdef __EMSCRIPTEN__
/* Веб-версия подключает canvas_gfx_core.inc напрямую из web_main.c,
 * потому что веб-главный цикл должен видеть типы/функции раньше времени. */
#else
#include "engine/graphics/types.inc"
#include "engine/graphics/geometry.inc"
#include "engine/graphics/vulkan_backend.inc"
#include "engine/graphics/fx_filters.inc"
#include "engine/graphics/autoscale.inc"
#include "engine/graphics/lifecycle.inc"
#include "engine/graphics/tex_round.inc"
#include "engine/graphics/frame_lifecycle.inc"
#include "engine/graphics/fallback_screen.inc"
#endif
