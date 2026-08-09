import { config } from "./config/env.js";
import { createDatabase, initSchema } from "./db/index.js";
import { buildApp } from "./app.js";

const db = createDatabase(config.DB_PATH);
initSchema(db);

const app = buildApp(db);

app.listen(config.PORT, () => {
    console.log(`Server is running on port ${config.PORT}`);
    console.log(`Using database ${config.DB_PATH}`);
});
