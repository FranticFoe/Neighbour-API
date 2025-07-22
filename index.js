let express = require("express");
let cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

let app = express();
app.use(cors());
app.use(express.json());

const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const req = require("express/lib/request");
const { DATABASE_URL } = process.env;
const { SECRET_KEY } = process.env;

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});

async function getPostgresVersion() {
    const client = await pool.connect();
    try {
        const response = await client.query("SELECT version()");
        console.log(response.rows[0]);
    } finally {
        client.release();
    }
}

getPostgresVersion();

app.post("/signup", async (req, res) => {
    const client = await pool.connect();
    try {
        const { email, username } = req.body;
        const result = await pool.query(
            "SELECT * FROM neighbours WHERE email = $1 OR username = $2",
            [email, username],
        );
        if (result.rows.length > 0) {
            return res
                .status(400)
                .json({ message: "Email or username already exists" });
        }
        await client.query(
            `INSERT INTO neighbours (email, username) VALUES ($1, $2 )`,
            [email, username],
        );
        await client.query(
            "INSERT INTO neighbour_profile (username, profile_name) VALUES ($1,$1)",
            [username],
        );
        console.log("New user registered.");
        res.status(201).json({ message: "User registered successfully" });
    } catch (err) {
        console.error("Error occured in signup: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/retrieveEmail", async (req, res) => {
    const client = await pool.connect();
    const { emailOrUsername } = req.body;
    try {
        const table = await client.query(
            "SELECT * FROM neighbours WHERE email = $1 OR username = $1",
            [emailOrUsername],
        );
        const userExists = table.rows[0];
        if (!userExists) {
            return res
                .status(400)
                .json({ message: "Invalid email or username" });
        }

        const email = userExists.email;
        console.log("Logged in user with ID", userExists.neighbour_id);
        console.log("Email: ", email);
        res.status(200).json({ auth: true, email });
    } catch (err) {
        console.error("Error occured in login: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/create/community", async (req, res) => {
    const client = await pool.connect();
    try {
        const {
            community_name,
            community_description,
            neighbour_username,
            latitude,
            longitude,
        } = req.body;
        const checkCommunity = await client.query(
            "SELECT * FROM community WHERE community_name = $1",
            [community_name],
        );

        if (checkCommunity.rows.length > 0) {
            return res
                .status(400)
                .json({ message: "Community already exists" });
        }

        await client.query(
            "INSERT INTO community (community_name, community_description, no_residents, leader_name, latitude, longitude) VALUES ($1, $2, 1, $3, $4, $5)",
            [
                community_name,
                community_description,
                neighbour_username,
                latitude,
                longitude,
            ],
        );
        await client.query(
            "UPDATE neighbours SET community_name = $1 WHERE username = $2",
            [community_name, neighbour_username],
        );
        res.status(201).json({ message: "Community created successfully" });
    } catch (err) {
        console.error("Error occured in creating community: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/invite/user", async (req, res) => {
    const client = await pool.connect();
    try {
        const { current_neighbour_id, community_name, invited_neighbour_id } =
            req.body;
        const checkCommunity = await client.query(
            "SELECT * FROM community WHERE community_name = $1 AND community_leader_id = $2",
            [community_name, current_neighbour_id],
        );
        if (checkCommunity.rows.length === 0) {
            return res.status(400).json({
                message: "Community does not exist or you are not the leader",
            });
        }
        const existingInvitation = await client.query(
            "SELECT * FROM community_invitations WHERE invitation_id = $1 AND community_name = $2",
            [invited_neighbour_id, community_name],
        );
        if (existingInvitation.rows.length > 0) {
            return res.status(400).json({ message: "User already invited." });
        }

        const existingNeighbour = await client.query(
            "SELECT * FROM neighbours WHERE neighbour_id = $1 AND community_name = $2",
            [invited_neighbour_id, community_name],
        );
        if (existingNeighbour.rows.length > 0) {
            return res
                .status(400)
                .json({ message: "User already in community." });
        }
        await client.query(
            "INSERT INTO community_invitations (invited_by, community_name, invited_user) VALUES ($1, $2, $3)",
            [current_neighbour_id, community_name, invited_neighbour_id],
        );
        res.status(200).json({ message: "Invitation sent." });
    } catch (err) {
        console.error("Error occured in inviting user: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/generate/invite-link", async (req, res) => {
    const client = await pool.connect();

    const { current_neighbour_id, community_name } = req.body;
    const checkLeader = await client.query(
        "SELECT * FROM community WHERE community_name = $1 AND community_leader_id = $2",
        [community_name, current_neighbour_id],
    );
    if (checkLeader.rows.length === 0) {
        return res
            .status(400)
            .json({ message: "You are not the leader of this community." });
    }
    try {
        const token = uuidv4();
        await client.query(
            "INSERT INTO community_invite_links (token, community_name, created_by) VALUES ($1, $2, $3)",
            [token, community_name, current_neighbour_id],
        );
        const base_url = "https://yourdomain.com/join";
        const full_link = `${base_url}?token=${token}`;
        res.status(201).json({ invite_link: full_link });
    } catch (err) {
        console.error("Error occured in generating invite link: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/join/by-link", async (req, res) => {
    const client = await pool.connect();
    try {
        const { token, neighbour_id } = req.body;

        const { rows } = await client.query(
            "SELECT * FROM community_invite_links WHERE token = $1 ",
            [token],
        );

        if (rows.length === 0) {
            return res
                .status(400)
                .json({ message: "Invalid or expired token." });
        }

        const community_name = rows[0].community_name;

        await client.query(
            "UPDATE neighbours SET community_name = $1 WHERE neighbour_id = $2",
            [community_name, neighbour_id],
        );

        await client.query(
            "UPDATE community SET no_residents = no_residents + 1 WHERE community_name = $1",
            [community_name],
        );

        res.status(200).json({ message: "Successfully joined community!" });
    } catch (err) {
        console.error("Error accepting invite link:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/accept/invite", async (req, res) => {
    const client = await pool.connect();
    try {
        const { neighbour_id, community_name } = req.body;
        const checkInvite = await client.query(
            "SELECT * FROM community_invitations WHERE invited_user = $1 AND community_name = $2",
            [neighbour_id, community_name],
        );
        if (checkInvite.rows.length === 0) {
            return res
                .status(400)
                .json({ message: "Invitation does not exist" });
        }
        await client.query(
            "UPDATE neighbours SET community_name = $1 WHERE neighbour_id = $2",
            [community_name, neighbour_id],
        );
        await client.query(
            "UPDATE community SET no_residents = no_residents + 1 WHERE community_name = $1",
            [community_name],
        );
        await client.query(
            "DELETE FROM community_invitations WHERE invited_user = $1 AND community_name = $2",
            [neighbour_id, community_name],
        );
        res.status(200).json({ message: "Invitation accepted." });
    } catch (err) {
        console.error("Error occured in accepting invite: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/decline/invite", async (req, res) => {
    const client = await pool.connect();
    try {
        const { neighbour_id, community_name } = req.body;
        const checkInvite = await client.query(
            "SELECT * FROM community_invitations WHERE invited_user = $1 AND community_name = $2",
            [neighbour_id, community_name],
        );
        if (checkInvite.rows.length === 0) {
            return res
                .status(400)
                .json({ message: "Invitation does not exist" });
        }
        await client.query(
            "DELETE FROM community_invitations WHERE invited_user = $1 AND community_name = $2",
            [neighbour_id, community_name],
        );
        res.status(200).json({ message: "Invitation declined." });
    } catch (err) {
        console.error("Error occured in declining invite: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/invites/pending/:neighbour_id", async (req, res) => {
    const client = await pool.connect();
    try {
        const { neighbour_id } = req.params;
        const invites = await client.query(
            "SELECT * FROM community_invitations WHERE invited_user = $1",
            [neighbour_id],
        );
        res.status(200).json({ pending_invites: invites.rows });
    } catch (err) {
        console.error("Error occured in getting pending invites: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/help", async (req, res) => {
    const client = await pool.connect();
    const {
        neighbour_username,
        community_name,
        task_title,
        task_description,
        images,
        capacity,
        date,
        start_time,
        duration,
        task_rewards,
    } = req.body;

    function addMinutesToHHMM(timeStr, minutesToAdd) {
        const [hh, mm] = timeStr.split(":").map(Number);
        const totalMinutes = hh * 60 + mm + minutesToAdd;
        const newH = Math.floor(totalMinutes / 60) % 24;
        const newM = totalMinutes % 60;
        return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`;
    }

    const checkneighbour = await client.query(
        "SELECT * FROM neighbours WHERE username = $1 AND community_name = $2",
        [neighbour_username, community_name],
    );
    if (checkneighbour.rows.length === 0) {
        return res
            .status(400)
            .json({ message: "Unregistered neighbour/community." });
    }

    try {
        let end_time = null;
        if (start_time && duration) {
            end_time = addMinutesToHHMM(start_time, duration);
        }
        await client.query(
            "INSERT INTO help_needed (username, community_name, task_title, description, images, capacity, date, start_time, end_time, task_rewards) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            [
                neighbour_username,
                community_name,
                task_title,
                task_description,
                images,
                capacity,
                date,
                start_time,
                end_time,
                task_rewards,
            ],
        );
        res.status(200).json({ message: "Help needed posted." });
    } catch (err) {
        console.error("Error occured in posting help needed: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/helpers", async (req, res) => {
    const client = await pool.connect();
    const { username, task_id } = req.body;

    try {
        // Check if neighbour is registered
        const checkneighbour = await client.query(
            "SELECT * FROM neighbours WHERE username = $1",
            [username],
        );
        if (checkneighbour.rows.length === 0) {
            return res.status(400).json({ message: "Unregistered neighbour." });
        }

        // Check if already helping
        const alreadyhelped = await client.query(
            "SELECT * FROM helpers WHERE username = $1 AND task_id = $2",
            [username, task_id],
        );
        if (alreadyhelped.rows.length > 0) {
            return res.status(400).json({ message: "Already helping." });
        }

        // Fetch task info
        const help_needed_result = await client.query(
            "SELECT * FROM help_needed WHERE id = $1",
            [task_id],
        );

        if (help_needed_result.rows.length === 0) {
            return res.status(404).json({ message: "Task not found." });
        }

        const help_needed = help_needed_result.rows[0];

        // Check if user is trying to help their own task
        if (help_needed.username === username) {
            return res.status(400).json({ message: "Cannot help yourself." });
        }

        // Check if task is already full
        if (help_needed.status === true) {
            return res.status(400).json({ message: "Task is already full." });
        }

        // Add helper
        await client.query(
            "INSERT INTO helpers (task_id, username) VALUES ($1, $2)",
            [task_id, username],
        );

        // Update current helpers count
        await client.query(
            "UPDATE help_needed SET current_helper = current_helper + 1 WHERE id = $1",
            [task_id],
        );

        // Re-fetch updated helper count
        const updated = await client.query(
            "SELECT capacity, current_helper FROM help_needed WHERE id = $1",
            [task_id],
        );
        const { capacity, current_helper } = updated.rows[0];

        // If capacity is null or has reached the limit, mark status true
        if (
            capacity === null ||
            (capacity !== null && current_helper >= capacity)
        ) {
            await client.query(
                "UPDATE help_needed SET status = true WHERE id = $1",
                [task_id],
            );
        }

        res.status(200).json({ message: "Helper added." });
    } catch (err) {
        console.error("Error occurred in adding helper: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/create/events", async (req, res) => {
    const client = await pool.connect();
    const { neighbour_id, community_name } = req.body;
    const checkLeader = await client.query(
        "SELECT * FROM community WHERE community_name = $1 AND community_leader_id = $2",
        [community_name, neighbour_id],
    );
    if (checkLeader.rows.length === 0) {
        return res
            .status(400)
            .json({ message: "You are not the leader of this community." });
    }
    try {
        const { date, start_time, end_time, event_title, event_description } =
            req.body;
        const created_by = await client.query(
            "SELECT username FROM neighbours WHERE neighbour_id = $1",
            [neighbour_id],
        );
        await client.query(
            "INSERT INTO events (date, start_time, end_time, event_title, event_description, community_name,created_by) VALUES ($1, $2, $3, $4, $5, $6,$7)",
            [
                date,
                start_time,
                end_time,
                event_title,
                event_description,
                community_name,
                created_by.rows[0].username,
            ],
        );
        res.status(200).json({ message: "Event created." });
    } catch (err) {
        console.error("Error occured in creating event: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/join/events", async (req, res) => {
    const client = await pool.connect();
    const { neighbour_username, event_title, community_name } = req.body;
    const checkNeighbour = await client.query(
        "SELECT * FROM neighbours WHERE username = $1 AND community_name = $2",
        [neighbour_username, community_name],
    );
    const checkEventCommunity = await client.query(
        "SELECT * FROM events WHERE community_name = $1 AND event_title =$2",
        [community_name, event_title],
    );

    if (
        checkNeighbour.rows.length === 0 &&
        checkEventCommunity.rows.length === 0
    ) {
        return res.status(400).json({
            message:
                "You are not a member of this community.//Event is not part of this community.",
        });
    }
    try {
        await client.query(
            "INSERT INTO participants_data ( neighbour_username, event_title, community_name) VALUES ($1, $2, $3)",
            [neighbour_username, event_title, community_name],
        );
        res.status(200).json({ message: "Event joined." });
    } catch (err) {
        console.error("Error occured in joining event: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/getParticipants", async (req, res) => {
    const client = await pool.connect();
    const { event_title, username, community_name } = req.body;
    const checkEventOrganizer = await client.query(
        "SELECT * FROM events WHERE event_title = $1 AND created_by =$2 AND community_name = $3 ",
        [event_title, username, community_name],
    );
    if (checkEventOrganizer.rows.length === 0) {
        return res
            .status(400)
            .json({ message: "You are not the organizer of this event." });
    }
    try {
        const participants = await client.query(
            "SELECT neighbour_username FROM participants_data WHERE event_title = $1 AND community_name = $2",
            [event_title, community_name],
        );
        res.status(200).json({ participants: participants.rows });
    } catch (err) {
        console.error("Error occured in getting participants: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/profile", async (req, res) => {
    const client = await pool.connect();
    const { neighbour_username, profile_name, profile_description } = req.body;
    try {
        checkProfile = await client.query(
            "SELECT * FROM profile WHERE neighbour_username = $1",
            [neighbour_username],
        );
        if (checkProfile.rows.length < 0) {
            await client.query(
                "INSERT INTO profile (neighbour_username, profile_name, profile_description) VALUES ($1, $2, $3)",
                [neighbour_username, profile_name, profile_description],
            );
            res.status(200).json({ message: "Profile created." });
        } else {
            await client.query(
                "UPDATE profile SET profile_name = $1, profile_description = $2 WHERE neighbour_username = $3",
                [profile_name, profile_description, neighbour_username],
            );
            res.status(200).json({ message: "Profile updated." });
        }
    } catch (err) {
        console.error("Error occured in creating/updating profile: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/profile/:username", async (req, res) => {
    const client = await pool.connect();
    const { username } = req.params;
    try {
        const profile = await client.query(
            "SELECT * FROM neighbour_profile WHERE username = $1",
            [username],
        );
        res.status(200).json({ profile: profile.rows });
    } catch (err) {
        console.error("Error occured in getting profile: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/community/:username", async (req, res) => {
    const client = await pool.connect();
    const { username } = req.params;
    try {
        const hascommunity = await client.query(
            "SELECT community_name FROM neighbours WHERE username = $1",
            [username],
        );
        res.status(200).json({ community: hascommunity.rows });
        if (hascommunity.rows.length === 0) {
            res.status(200).json({ status: true });
        }
    } catch (err) {
        console.error("Error occured in getting community: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/availableCommunities", async (req, res) => {
    const client = await pool.connect();
    try {
        const communities = await client.query(
            "SELECT community_name FROM community",
        );
        res.status(200).json({ communities: communities.rows });
    } catch (err) {
        console.error("Error occured in getting communities: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/events/:community_name", async (req, res) => {
    const client = await pool.connect();
    const { community_name } = req.params;
    try {
        const events = await client.query(
            "SELECT * FROM events WHERE community_name = $1",
            [community_name],
        );
        res.status(200).json({ events: events.rows });
    } catch (err) {
        console.error("Error occured in getting events: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/help/:community_name", async (req, res) => {
    const client = await pool.connect();
    const { community_name } = req.params;
    try {
        const help = await client.query(
            "SELECT * FROM help_needed WHERE community_name = $1",
            [community_name],
        );
        res.status(200).json({ help: help.rows });
    } catch (err) {
        console.error("Error occured in getting help: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/join/request", async (req, res) => {
    const client = await pool.connect();
    const { community_name, username } = req.body;
    const has_community = await client.query(
        "SELECT community_name FROM neighbours WHERE username = $1",
        [username],
    );

    if (has_community.rows.community_name != null) {
        return res
            .status(400)
            .json({ message: "You are already in a community." });
    }
    const checkExistingRequest = await client.query(
        "SELECT * FROM community_join_request WHERE community_name = $1 AND sender_name = $2",
        [community_name, username],
    );
    if (checkExistingRequest.rows.length > 0) {
        return res
            .status(400)
            .json({ message: "You have already sent a join request." });
    }
    try {
        await client.query(
            "INSERT INTO community_join_request (community_name, sender_name) VALUES ($1, $2)",
            [community_name, username],
        );
        res.status(200).json({ message: "Join request sent." });
    } catch (err) {
        console.error("Error occured in sending join request: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/join/request/:community_name", async (req, res) => {
    const client = await pool.connect();
    const { community_name } = req.params;
    try {
        const requests = await client.query(
            "SELECT username FROM community_join_requests WHERE community_name = $1",
            [community_name],
        );
        res.status(200).json({ requests: requests.rows });
    } catch (err) {
        console.error("Error occured in getting join requests: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.post("/neighbour/join/request/accept", async (req, res) => {
    const client = await pool.connect();
    const { community_name, username, sender_name } = req.body;
    const isleader = await client.query(
        "SELECT * FROM community WHERE community_name = $1 AND leader_name = $2",
        [community_name, username],
    );
    if (isleader.rows.length === 0) {
        return res
            .status(400)
            .json({ message: "You are not the leader of this community." });
    }
    7;
    try {
        await client.query(
            "UPDATE neighbours SET community_name = $1 WHERE username = $2",
            [community_name, sender_name],
        );
        await client.query(
            "DELETE FROM community_join_request WHERE community_name = $1 AND sender_name = $2",
            [community_name, sender_name],
        );
        res.status(200).json({ message: "Join request accepted." });
    } catch (err) {
        console.error("Error occured in accepting join request: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/neighbour/availableCommunities/location", async (req, res) => {
    const client = await pool.connect();
    try {
        const result = await client.query("SELECT * FROM community");

        const mapped = result.rows
            .filter(row => row.latitude !== null && row.longitude !== null)
            .map(row => ({
                community_name: row.community_name,
                latitude: row.latitude,
                longitude: row.longitude,
            }));

        res.json({ communities: mapped });
    } catch (err) {
        console.error("Error occurred in getting communities: ", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
});

app.get("/", (req, res) => {
    res.status(200).json({ message: "Welcome to the neighbour API! " });
});

app.listen(3000, () => {
    console.log("App is listening on port 3000");
});

//very unsecure, add a check token fo access to all endpoints
// make invite link expire in 24 hours
