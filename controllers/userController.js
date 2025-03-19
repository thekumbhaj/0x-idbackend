const { db } = require('../config/db');

const getUserRole = async (req, res) => {
  try {
    const { userId } = req.params;

    // Query to fetch user admin status
    const [results] = await db.query("SELECT is_admin FROM users WHERE id = ?", [userId]);
    
    if (!results.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const isAdmin = results[0].is_admin;
    // Convert 0/1 to a more meaningful response
    const role = isAdmin === 1 ? "admin" : "user";
    return res.status(200).json({ role: role });
  } catch (error) {
    console.error("Error fetching user role:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getUserRole };