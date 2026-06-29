/** DI-токен пула PostgreSQL. Вынесен отдельно, чтобы разорвать
 *  циклический импорт между database.module и db.service. */
export const PG_POOL = 'PG_POOL';
