const userSchema = new mongoose.Schema({
    telegramId: { type: Number, unique: true, required: true },
    username: { type: String, required: true },
    click_id: { type: String, default: "none" },
    complete: { type: [String], default: [] },
  });
  const User = mongoose.model("User", userSchema);