# Vision Domain Glossary

- **Primary model:** the model the current agent/session runs on.
- **Vision model (delegate model):** an auxiliary model that accepts images on input and is delegated image analysis when the primary model is text-only.
- **Multimodal model:** a model that accepts images on input (`input` contains `"image"`).
- **Text-only model:** a model that accepts only text on input.
- **Capability-aware (delegation by capability):** choosing behavior based on the primary model's input modalities.
- **Native image delivery:** reading an image file with the built-in `read` tool, which returns it as image-content; the model sees the image directly.
- **Delegation:** calling a vision model to obtain a text answer about an image.
- **describe_image:** the image-analysis tool visible only to a text-only model; accepts a mandatory prompt and one or more image paths.
- **Retry:** re-calling the vision model on a retryable error with exponential backoff.
