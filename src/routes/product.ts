import { Router } from "express";

const router = Router();

router.get("/", (_, res) => {
    res.status(200).json({ message: "List of products" });
});

router.post("/", (req, res) => {
    const product = req.body;
    // Logic to save the product would go here
    res.status(201).json({ message: "Product created", product });
});

router.get("/:id", (req, res) => {
    const productId = req.params.id;
    // Logic to retrieve the product by ID would go here
    res.status(200).json({ message: `Details of product ${productId}` });
});

router.put("/:id", (req, res) => {
    const productId = req.params.id;
    const updatedProduct = req.body;
    // Logic to update the product by ID would go here
    res.status(200).json({ message: `Product ${productId} updated`, updatedProduct });
});

router.delete("/:id", (req, res) => {
    const productId = req.params.id;
    // Logic to delete the product by ID would go here
    res.status(200).json({ message: `Product ${productId} deleted` });
});

export default router;