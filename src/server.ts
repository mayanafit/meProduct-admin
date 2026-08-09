import express from "express";
import { productRoutes, orderRoutes } from "./routes/index.js";
import { initSchema } from "./db/index.js";

initSchema();
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_, res) => {
    res.status(200).json({ message: "Welcome to the server!" });
});
app.use("/products", productRoutes);
app.use("/orders", orderRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
}); 