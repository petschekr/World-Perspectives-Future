import * as fs from "fs";
import * as crypto from "crypto";
import * as common from "../common";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as neo4j from "neo4j";
import * as moment from "moment";
import * as slugMaker from "slug";
import * as Sendgrid from "sendgrid";
import * as multer from "multer";

export let adminRouter = express.Router();

let postParser = bodyParser.json();
let sendgrid = Sendgrid(common.keys.sendgrid);
let uploadHandler = multer({
	"storage": multer.memoryStorage(),
	"limits": {
		"fileSize": 1000000 * 10, // 10 MB
		"files": 1,
		"fields": 0
	},
	"fileFilter": function (request, file, callback) {
		const excelMimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		if (file.mimetype === excelMimeType && !!file.originalname.match("\.xlsx$")) {
			callback(null!, true);
		}
		else {
			callback(null!, false);
		}
	}
});
const xlsx = require("node-xlsx");

type User = common.User;
const timeFormat: string = "h:mm A";
const dateFormat: string = "MMMM Do, YYYY";

let authenticateCheck = common.authenticateMiddleware;
let adminCheck = function (request: express.Request, response: express.Response, next: express.NextFunction): void {
	if (!response.locals.authenticated || !response.locals.user.admin) {
		if (request.method === "GET") {
			response.redirect("/");
		}
		else {
			response.status(403).send("Forbidden to non-admin users");
		}
	}
	else {
		next();
	}
};
adminRouter.use(authenticateCheck, adminCheck);

adminRouter.route("/").get(async (request, response) => {
	response.send(await common.readFileAsync("pages/admin.html"));
});

adminRouter.route("/user")
	.get(async (request, response) => {
		if (request.query.all && request.query.all.toLowerCase() === "true") {
			// All users' names for autocomplete
			try {
				let results = await common.cypherAsync({
					query: "MATCH (user:User) RETURN user.name AS name ORDER BY last(split(user.name, \" \"))"
				});
				response.json(results.map((user: any) => {
					return user.name;
				}));
			}
			catch (err) {
				common.handleError(response, err);
			}
		}
		else {
			const usersPerPage = 10;
			let page = parseInt(request.query.page, 10);
			if (isNaN(page) || page < 0) {
				page = 0;
			}
			let filter = request.query.filter;
			let criteria: string = "";
			if (!filter)
				filter = "all";
			if (filter === "all") {
				criteria = "";
			}
			else if (filter === "freshman") {
				criteria = "grade: 9";
			}
			else if (filter === "sophomore") {
				criteria = "grade: 10";
			}
			else if (filter === "junior") {
				criteria = "grade: 11";
			}
			else if (filter === "senior") {
				criteria = "grade: 12";
			}
			else if (filter === "admin") {
				criteria = "admin: true";
			}
			else if (filter === "nonadmin") {
				criteria = "admin: false";
			}
			else {
				criteria = "type: {type}";
			}
			try {
				let results = await Promise.all<any[], any[]>([
					common.cypherAsync({
						query: `MATCH (user:User {${criteria}}) RETURN user.username AS username, user.name AS name, user.email AS email, user.registered AS registered, user.admin AS admin, user.type AS type, user.code AS code ORDER BY last(split(user.name, " ")) SKIP {skip} LIMIT {limit}`,
						params: {
							skip: page * usersPerPage,
							limit: usersPerPage,
							type: common.getUserType(filter)
						}
					}),
					common.cypherAsync({
						query: `MATCH (user:User {${criteria}}) RETURN count(user) AS total`,
						params: {
							type: common.getUserType(filter)
						}
					})
				]);
				response.json({
					"info": {
						"page": page + 1,
						"pageSize": usersPerPage,
						"total": results[1][0].total,
						"totalPages": Math.ceil(results[1][0].total / usersPerPage)
					},
					"data": results[0].map(function (user) {
						if (!user.email) {
							user.email = `${user.username}@gfacademy.org`
						}
						return user;
					})
				});
			}
			catch (err) {
				common.handleError(response, err);
			}
		}
	})
	.post(uploadHandler.single("import"), async (request, response) => {
		let data: any;
		try {
			// CAUTION: This is a blocking method
			data = xlsx.parse(request.file.buffer);
		}
		catch (err) {
			response.json({ "success": false, "message": "Invalid Excel file uploaded" });
			return;
		}
		if (data.length !== 2) {
			response.json({ "success": false, "message": "Please put students on the first sheet and faculty on the second" });
			return;
		}
		let queries: object[] = [];
		let emailRegEx = /^(.*?)@gfacademy.org$/i;
		// Students
		for (let i = 0; i < data[0].data.length; i++) {
			let student = data[0].data[i];
			if (student.length === 0)
				continue;
			let firstName = student[0];
			let lastName = student[1];
			let email = student[2];
			let grade = parseInt(student[3], 10);
			if ((!firstName || !lastName || !email || isNaN(grade)) && i !== 0) {
				response.json({ "success": false, "message": "Invalid format for students. Expected first name, last name, email, grade." });
				return;
			}
			let emailParsed = email.match(emailRegEx);
			// Check if there is actually an email in the email field. If not, it's probably the header
			if (!emailParsed)
				continue;
			let code = crypto.randomBytes(16).toString("hex");
			queries.push({
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}, grade: {grade}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					type: common.UserType.Student,
					admin: false,
					code: code,
					grade: grade
				}
			});
		}
		// Faculty
		for (let i = 0; i < data[1].data.length; i++) {
			let teacher = data[1].data[i];
			if (teacher.length === 0)
				continue;
			let firstName = teacher[0];
			let lastName = teacher[1];
			let email = teacher[2];
			if (!firstName || !lastName || !email) {
				response.json({ "success": false, "message": "Invalid format for faculty. Expected first name, last name, email." });
				return;
			}
			let emailParsed = email.match(emailRegEx);
			// Check if there is actually an email in the email field. If not, it's probably the header
			if (!emailParsed)
				continue;
			let code = crypto.randomBytes(16).toString("hex");
			queries.push({
				"query": "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
				params: {
					name: `${firstName} ${lastName}`,
					username: emailParsed[1],
					registered: false,
					type: common.UserType.Teacher,
					admin: false,
					code: code
				}
			});
		}
		try {
			await common.cypherAsync({ queries: queries })
			response.json({ "success": true, "message": `${queries.length} users successfully created` });
		}
		catch (err) {
			if (err instanceof neo4j.ClientError) {
				response.json({ "success": false, "message": "A user with an existing username or name can't be imported. Rolling back changes." });
				return;
			}
			common.handleError(response, err);
		}
	})
	.delete(async (request, response) => {
		try {
			await common.cypherAsync({
				query: "MATCH (user:User {admin: false}) DETACH DELETE user"
			});
			await common.cypherAsync({
				query: "MATCH (user:User {admin: true}) SET user.registered = false"
			});
			response.json({ "success": true, "message": "All non-admin users successfully deleted" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/user/:username")
	.get(async (request, response) => {
		let username = request.params.username;
		try {
			let results = await common.cypherAsync({
				query: "MATCH (user:User {username: {username}}) RETURN user.username AS username, user.name AS name, user.email AS email, user.registered AS registered, user.admin AS admin, user.type AS type, user.code AS code",
				params: {
					username: username
				}
			});
			if (results.length == 0) {
				results = null;
			}
			else {
				results = results[0];
				if (!results.email) {
					results.email = `${results.username}@gfacademy.org`
				}
			}
			response.json(results);
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.put(postParser, async (request, response) => {
		// Generate a unique code for this user
		let code = crypto.randomBytes(16).toString("hex");
		let name = request.body.name;
		let username = request.params.username;
		if (!name || !username) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
		name = name.toString().trim();
		username = username.toString().toLowerCase().trim();
		if (!name || !username) {
			response.json({ "success": false, "message": "Please enter both the user's name and username" });
			return;
		}
		let isTeacher = !!request.body.teacher;
		let isAdmin = !!request.body.admin;
		try {
			await common.cypherAsync({
				query: "CREATE (user:User {name: {name}, username: {username}, registered: {registered}, type: {type}, admin: {admin}, code: {code}})",
				params: {
					name: name,
					username: username,
					registered: false,
					type: isTeacher ? common.UserType.Teacher : common.UserType.Student,
					admin: isAdmin,
					code: code
				}
			});
			response.json({ "success": true, "message": "User successfully created" });
		}
		catch (err) {
			if (err instanceof neo4j.ClientError) {
				response.json({ "success": false, "message": "A user with that username or name already exists" });
				return;
			}
			common.handleError(response, err);
		}
	})
	.delete(async (request, response) => {
		let username = request.params.username;
		try {
			await common.cypherAsync({
				query: "MATCH (user:User {username: {username}}) DETACH DELETE user",
				params: {
					username: username
				}
			});
			response.json({ "success": true, "message": "User deleted successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/move/:name")
	.get(async (request, response) => {
		let {name}: { name: string } = request.params;

		try {
			let [users, editablePeriods, attends, presents, moderates] = await Promise.all<User[], any[], any[], any[], any[]>([
				common.cypherAsync({
					"query": "MATCH (u:User) WHERE u.name = {name} OR u.username = {name} RETURN u.name AS name, u.username AS username, u.code AS code, u.registered AS registered",
					"params": {
						name: name
					}
				}),
				common.cypherAsync({
					"query": "MATCH(item:ScheduleItem {editable: true }) RETURN item.title AS title, item.start AS startTime, item.end AS endTime"
				}),
				common.cypherAsync({
					"query": `MATCH (u:User) WHERE u.name = {name} OR u.username = {name}
							MATCH (u)-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type`,
					"params": {
						name: name
					}
				}),
				common.cypherAsync({
					"query": `MATCH (u:User) WHERE u.name = {name} OR u.username = {name}
							MATCH (u)-[r:PRESENTS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type`,
					"params": {
						name: name
					}
				}),
				common.cypherAsync({
					"query": `MATCH (u:User) WHERE u.name = {name} OR u.username = {name}
							MATCH (u)-[r:MODERATES]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type`,
					"params": {
						name: name
					}
				})
			]);
			
			if (users.length !== 1) {
				response.json({ "success": false, "message": "User not found" });
				return;
			}
			let user = users[0];

			function findByTime (item: any[], time: moment.Moment): any {
				for (let i = 0; i < item.length; i++) {
					if (time.isSame(moment(item[i].startTime))) {
						return item[i];
					}
				}
				return null;
			}
			function formatSession (item: any, mandatory: boolean = false): any {
				return {
					"title": {
						"formatted": item.title,
						"slug": item.slug || null
					},
					"time": {
						"start": {
							"raw": item.startTime,
							"formatted": moment(item.startTime).format(timeFormat)
						},
						"end": {
							"raw": item.endTime,
							"formatted": moment(item.endTime).format(timeFormat)
						}
					},
					"type": item.type || null,
					"mandatory": mandatory
				};
			}

			let periods = editablePeriods.map(function (period) {
				let startTime = moment(period.startTime);
				let presenting = findByTime(presents, startTime);
				if (presenting) {
					return formatSession(presenting, true);
				}
				let moderating = findByTime(moderates, startTime);
				if (moderating) {
					return formatSession(moderating, true);
				}
				let attending = findByTime(attends, startTime);
				if (attending) {
					return formatSession(attending);
				}
				period.title = "Free";
				return formatSession(period);
			});
			response.json({ "success": true, "data": periods, "user": user });
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.post(postParser, async (request, response) => {
		let {username, slugs}: { username: string, slugs: string[] } = request.body;
		try {
			let [users, editablePeriods, attends, presents, moderates] = await Promise.all<User[], any[], any[], any[], any[]>([
				common.cypherAsync({
					"query": "MATCH (u:User {username: {username}}) RETURN u.name AS name, u.username AS username, u.registered AS registered",
					"params": {
						username: username
					}
				}),
				common.cypherAsync({
					"query": "MATCH(item:ScheduleItem {editable: true }) RETURN item.title AS title, item.start AS startTime, item.end AS endTime"
				}),
				common.cypherAsync({
					"query": "MATCH (u:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type",
					"params": {
						username: username
					}
				}),
				common.cypherAsync({
					"query": "MATCH (u:User {username: {username}})-[r:PRESENTS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type",
					"params": {
						username: username
					}
				}),
				common.cypherAsync({
					"query": "MATCH (u:User {username: {username}})-[r:MODERATES]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS startTime, s.endTime AS endTime, s.type AS type",
					"params": {
						username: username
					}
				})
			]);

			if (users.length !== 1) {
				response.json({ "success": false, "message": "User not found" });
				return;
			}
			let user = users[0];
			if (editablePeriods.length !== slugs.length) {
				response.json({ "success": false, "message": "Incorrect number of changes for editable periods" });
				return;
			}
			// Remove from already registered sessions
			await common.cypherAsync({
				"query": "MATCH (u:User {username: {username}})-[r:ATTENDS]->(s:Session) SET s.attendees = s.attendees - 1 DELETE r REMOVE u.hasFree, u.timeOfFree",
				"params": {
					username: username
				}
			});
			
			// Frees have null as their slug
			slugs = slugs.filter(slug => slug !== null);
			for (let slug of slugs) {
				await common.cypherAsync({
					"query": `
								MATCH (user:User {username: {username}})
								MATCH (session:Session {slug: {slug}})
								CREATE (user)-[r:ATTENDS]->(session)
								SET session.attendees = session.attendees + 1
								SET user.registered = true`,
					"params": {
						username: username,
						slug: slug
					}
				});
			}
			response.json({ "success": true, "message": "User moved successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/session")
	.get(async (request, response) => {
		try {
			let sessions: any[] = await common.cypherAsync({
				query: `MATCH (s:Session) RETURN
					s.title AS title,
					s.slug AS slug,
					s.description AS description,
					s.type AS type,
					s.location AS location,
					s.capacity AS capacity,
					s.attendees AS attendees,
					s.startTime AS startTime,
					s.endTime AS endTime
					ORDER BY s.startTime, lower(s.title)`
			});
			sessions = await Promise.all(sessions.map(async session => {
				let sessionRelationships = await common.cypherAsync({
					queries: [{
						query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
						params: {
							slug: session.slug
						}
					}, {
						query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: { slug }}) RETURN user.username AS username, user.name AS name",
						params: {
							slug: session.slug
						}
					}]
				});
				return {
					"title": {
						"formatted": session.title,
						"slug": session.slug
					},
					"description": session.description,
					"type": session.type,
					"location": session.location,
					"capacity": {
						"total": session.capacity,
						"filled": session.attendees
					},
					"time": {
						"start": {
							"raw": session.startTime,
							"formatted": moment(session.startTime).format(timeFormat)
						},
						"end": {
							"raw": session.endTime,
							"formatted": moment(session.endTime).format(timeFormat)
						},
						"date": moment(session.startTime).format(dateFormat)
					},
					"presenters": sessionRelationships[0],
					"moderator": (sessionRelationships[1].length !== 0) ? sessionRelationships[1][0] : null
				};
			}));
			response.json(sessions);
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.post(postParser, async (request, response) => {
		let title = request.body.title;
		let slug = slugMaker(title, { "lower": true });
		let description = request.body.description;
		let location = request.body.location;
		let capacity = request.body.capacity;
		let sessionType = request.body.type;
		let periodID = request.body.periodID;
		let presenters: any[] = request.body.presenters;
		let moderator = request.body.moderator;
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		if (!title || !location || !sessionType || !periodID) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		if (description) {
			description = description.toString().trim();
		}
		else {
			description = null;
		}
		location = location.toString().trim();
		sessionType = sessionType.toString().trim();
		periodID = periodID.toString().trim();
		if (!title || !location || !sessionType) {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		if (!isInteger(capacity) || capacity < 1) {
			response.json({ "success": false, "message": "Please enter a valid capacity" });
			return;
		}
		if (moderator) {
			moderator = moderator.toString().trim();
		}
		if (!Array.isArray(presenters) || presenters.length < 1) {
			response.json({ "success": false, "message": "Please add a presenter" });
			return;
		}
		if (moderator && sessionType !== "Panel") {
			response.json({ "success": false, "message": "Only panels can have a moderator" });
			return;
		}
		if (sessionType !== "Panel" && presenters.length > 1) {
			response.json({ "success": false, "message": "Only one presenter is allowed per session" });
			return;
		}
		if (!moderator && sessionType === "Panel") {
			response.json({ "success": false, "message": "Panels must have a moderator" });
			return;
		}
		presenters = presenters.map(function (presenter) {
			return presenter.name;
		});
		let allUsers = (!moderator) ? presenters : presenters.concat(moderator);
		let tx = common.dbRaw.beginTransaction();
		// Make sure that all presenters and moderators actually exist
		try {
			let results = await common.cypherAsync({
				query: "MATCH (u:User) WHERE u.name IN { names } RETURN count(u) AS users",
				params: {
					names: allUsers
				}
			});
			if (allUsers.length !== results[0].users) {
				if (sessionType !== "Panel") {
					response.json({ "success": false, "message": "The presenter could not be found" });
				}
				else {
					response.json({ "success": false, "message": "The moderator or one or more presenters could not be found" });
				}
				return;
			}

			let period = await common.cypherAsync({
				query: "MATCH (item:ScheduleItem {id: {id}, editable: true}) RETURN item.id AS id, item.start AS start, item.end AS end",
				params: {
					id: periodID
				}
			});
			if (period.length !== 1) {
				response.json({ "success": false, "message": "A customizable period with that ID could not be found" });
				return;
			}

			function cypherAsyncWithTx(tx: neo4j.Transaction, options: neo4j.CypherOptions): Promise<any> {
				return new Promise<any>((resolve, reject) => {
					tx.cypher(options, (err: Error | null, results) => {
						if (err) {
							reject(err);
						}
						else {
							resolve(results);
						}
					});
				});
			}
			results = await cypherAsyncWithTx(tx, {
				query: `CREATE (session:Session {
					title: { title },
					slug: { slug },
					description: { description },
					type: { type },
					location: { location },
					capacity: { capacity },
					attendees: { attendees },
					startTime: { startTime },
					endTime: { endTime }
				})`,
				params: {
					title: title,
					slug: slug,
					description: description,
					location: location,
					capacity: capacity,
					attendees: 0,
					type: sessionType,
					startTime: period[0].start,
					endTime: period[0].end
				}
			});
			for (let presenter of presenters) {
				await cypherAsyncWithTx(tx, {
					query: `
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:PRESENTS]->(session)`,
					params: {
						name: presenter,
						slug: slug
					}
				});
				if (moderator) {
					await cypherAsyncWithTx(tx, {
						query: `
							MATCH (user:User {name: { name }})
							MATCH (session:Session {slug: { slug }})
							CREATE (user)-[r:MODERATES]->(session)`,
						params: {
							name: moderator,
							slug: slug
						}
					});
				}
			}
			await new Promise<void>((resolve, reject) => {
				tx.commit((err: Error | null) => {
					if (err) {
						reject(err);
					}
					else {
						resolve();
					}
				});
			});
			response.json({ "success": true, "message": "Session successfully created" });
		}
		catch (err) {
			if (err instanceof neo4j.ClientError) {
				response.json({ "success": false, "message": "A session with that title already exists" });
				return;
			}
			tx.rollback(() => {
				common.handleError(response, err);
			});
		}
	});
adminRouter.route("/session/:slug")
	.get(async (request, response) => {
		let slug = request.params.slug;
		try {
			let results: any[] = await common.cypherAsync({
				queries: [{
					query: `MATCH (s:Session {slug: {slug}}) RETURN
						s.title AS title,
						s.slug AS slug,
						s.description AS description,
						s.type AS type,
						s.location AS location,
						s.capacity AS capacity,
						s.attendees AS attendees,
						s.startTime AS startTime,
						s.endTime AS endTime`,
					params: {
						slug: slug
					}
				}, {
					query: "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name ORDER BY last(split(user.name, \" \"))",
					params: {
						slug: slug
					}
				}, {
					query: "MATCH (user:User)-[r:MODERATES]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name",
					params: {
						slug: slug
					}
				}]
			});
			let [sessions, presenters, moderators] = results;
			if (sessions.length == 0) {
				response.json(null);
			}
			else {
				response.json({
					"title": {
						"formatted": sessions[0].title,
						"slug": sessions[0].slug
					},
					"description": sessions[0].description,
					"type": sessions[0].type,
					"location": sessions[0].location,
					"capacity": {
						"total": sessions[0].capacity,
						"filled": sessions[0].attendees
					},
					"time": {
						"start": {
							"raw": sessions[0].startTime,
							"formatted": moment(sessions[0].startTime).format(timeFormat)
						},
						"end": {
							"raw": sessions[0].endTime,
							"formatted": moment(sessions[0].endTime).format(timeFormat)
						},
						"date": moment(sessions[0].startTime).format(dateFormat)
					},
					"presenters": presenters,
					"moderator": (moderators.length !== 0) ? moderators[0] : null
				});
			}
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.delete(async (request, response) => {
		let slug = request.params.slug;
		try {
			await common.cypherAsync({
				query: "MATCH (s:Session {slug: {slug}}) DETACH DELETE s",
				params: {
					slug: slug
				}
			});
			response.json({ "success": true, "message": "Session deleted successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/session/:slug/attendance").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/session.html"));
});
adminRouter.route("/session/:slug/attendance/data").get(async (request, response) => {
	let slug = request.params.slug;
	try {
		let results: any[] = await common.cypherAsync({
			"query": "MATCH (user:User)-[r:ATTENDS]->(s:Session {slug: {slug}}) RETURN user.username AS username, user.name AS name, user.type AS type ORDER BY last(split(user.name, \" \"))",
			"params": {
				slug: slug
			}
		});
		let students = results.filter(user => {
			return user.type === common.UserType.Student;
		});
		let faculty = results.filter(user => {
			return user.type === common.UserType.Teacher;
		});
		response.json({
			"faculty": faculty,
			"students": students
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/free/:id").get(async (request, response) => {
	let id = request.params.id;
	try {
		let results = await common.cypherAsync({
			"query": "MATCH (item:ScheduleItem {id: {id}}) RETURN item.title AS title, item.start AS startTime, item.end AS endTime",
			"params": {
				id: id
			}
		});
		response.json({
			"title": {
				"formatted": results[0].title + " Free",
				"slug": null
			},
			"description": "",
			"type": "Free",
			"location": "N/A",
			"capacity": {
				"total": 0,
				"filled": 0
			},
			"time": {
				"start": {
					"raw": results[0].startTime,
					"formatted": moment(results[0].startTime).format(timeFormat)
				},
				"end": {
					"raw": results[0].endTime,
					"formatted": moment(results[0].endTime).format(timeFormat)
				},
				"date": moment(results[0].startTime).format(dateFormat)
			},
			"presenters": [{"name": "N/A"}],
			"moderator": null
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/free/:id/attendance").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/session.html"));
});
adminRouter.route("/free/:id/attendance/data").get(async (request, response) => {
	let id = request.params.id;
	try {
		let results: any[] = await common.cypherAsync({
			"query": "MATCH (item:ScheduleItem {id: {id}}) MATCH (user:User {registered: true}) WHERE NOT (user)-[:ATTENDS]->(:Session {startTime: item.start}) RETURN user.username AS username, user.name AS name, user.type AS type ORDER BY last(split(user.name, \" \"))",
			"params": {
				id: id
			}
		});
		let students = results.filter(function (user) {
			return user.type === common.UserType.Student;
		});
		let faculty = results.filter(function (user) {
			return user.type === common.UserType.Teacher;
		});
		response.json({
			"faculty": faculty,
			"students": students
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/schedule")
	.get(async (request, response) => {
		try {
			let results: any[] = await common.cypherAsync({
				query: "MATCH (item:ScheduleItem) RETURN item.id AS id, item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable ORDER BY item.start"
			});
			response.json(results.map(function (item) {
				let startTime = item.start;
				delete item.start;
				let endTime = item.end;
				delete item.end;
				item.time = {
					"start": {
						"raw": startTime,
						"formatted": moment(startTime).format(timeFormat)
					},
					"end": {
						"raw": endTime,
						"formatted": moment(endTime).format(timeFormat)
					}
				};
				return item;
			}));
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.patch(postParser, async (request, response) => {
		function isInteger(value: any): boolean {
			return typeof value === "number" &&
				isFinite(value) &&
				Math.floor(value) === value;
		}
		let { id, title, startTime, duration, location, customizable }: {
			id: string,
			title: string,
			startTime: string,
			duration: number,
			location: string | null,
			customizable: boolean
		} = request.body;
		if (!id) {
			response.json({ "success": false, "message": "Missing ID" });
			return;
		}
		if (!title || !startTime || !duration || typeof customizable !== "boolean") {
			response.json({ "success": false, "message": "Please enter missing information" });
			return;
		}
		title = title.toString().trim();
		startTime = startTime.toString().trim();
		if (location) {
			location = location.toString().trim();
		}
		else {
			location = null;
		}
		if (!isInteger(duration) || duration < 1) {
			response.json({ "success": false, "message": "Please enter a valid duration" });
			return;
		}
		try {
			let date = await common.getSymposiumDate();
			let start = moment(startTime, timeFormat);
			start.set("year", date.get("year"));
			start.set("month", date.get("month"));
			start.set("date", date.get("date"));
			let end = start.clone().add(duration, "minutes");

			if (!start.isValid() || !end.isValid()) {
				response.json({ "success": false, "message": "Invalid start time or duration" });
				return;
			}

			await common.cypherAsync({
				query: "MATCH (item:ScheduleItem {id: {id}}) SET item.title = {title}, item.start = {startTime}, item.end = {endTime}, item.location = {location}, item.editable = {customizable}",
				params: {
					id: id,
					title: title,
					startTime: start.format(),
					endTime: end.format(),
					location: location,
					customizable: customizable
				}
			});
			response.json({ "success": true, "message": "Updated successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});

// Very similar to schedule code in data.ts (keep the two roughly in sync if changes are made)
async function getScheduleForUser(user: { name: string; username: string; registered: boolean; }): Promise<{ "name": string; "schedule": any[] }> {
	if (!user.registered) {
		// Generalized schedule for unregistered users
		let results: any[] = await common.cypherAsync({
			query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
		});
		results = results.map(function (item) {
			let startTime = item.start;
			delete item.start;
			let endTime = item.end;
			delete item.end;
			item.time = {
				"start": {
					"raw": startTime,
					"formatted": moment(startTime).format(timeFormat)
				},
				"end": {
					"raw": endTime,
					"formatted": moment(endTime).format(timeFormat)
				}
			};
			return item;
		});
		return {
			"name": user.name,
			"schedule": results
		};
	}
	else {
		// Schedule for registered users
		let sessions: any[] = await common.cypherAsync({
			"query": "MATCH (user:User {username: {username}})-[r:ATTENDS]->(s:Session) RETURN s.title AS title, s.slug AS slug, s.startTime AS start, s.endTime AS end, s.location AS location, s.type AS type, s.description AS description, true AS editable",
			"params": {
				username: user.username
			}
		});
		let sessionsWithNames = await Promise.all(sessions.map(attendingSession => {
			return common.cypherAsync({
				"query": "MATCH (user:User)-[r:PRESENTS]->(s:Session {slug: {slug}}) RETURN user.name AS name, s.slug AS slug",
				"params": {
					slug: attendingSession.slug
				}
			});
		}));
		let items = await common.cypherAsync({
			query: "MATCH (item:ScheduleItem) RETURN item.title AS title, item.start AS start, item.end AS end, item.location AS location, item.editable AS editable"
		});
		
		function formatter (item: any) {
			let startTime = item.start;
			delete item.start;
			let endTime = item.end;
			delete item.end;
			item.time = {
				"start": {
					"raw": startTime,
					"formatted": moment(startTime).format(timeFormat)
				},
				"end": {
					"raw": endTime,
					"formatted": moment(endTime).format(timeFormat)
				}
			};
			return item;
		}
		// Flatten array
		sessionsWithNames = [].concat.apply([], sessionsWithNames);
		for (let i = 0; i < items.length; i++) {
			// Insert registration choices into schedule at editable periods
			if (items[i].editable) {
				let set = false;
				for (let j = 0; j < sessions.length; j++) {
					if (moment(sessions[j].start).isSame(moment(items[i].start))) {
						items[i] = sessions[j];
						set = true;
						let people = [];
						for (let k = 0; k < sessionsWithNames.length; k++) {
							if (sessionsWithNames[k].slug === sessions[j].slug) {
								people.push(sessionsWithNames[k].name);
							}
						}
						// Sort people by last name
						people = people.sort(function (a, b) {
							let aSplit = a.toLowerCase().split(" ");
							let bSplit = b.toLowerCase().split(" ");
							a = aSplit[aSplit.length - 1];
							b = bSplit[bSplit.length - 1];
							if (a < b) return -1;
							if (a > b) return 1;
							return 0;
						});
						items[i].people = people.join(", ");
						// Return type of form "Global" or "Science" instead of including "session" at the end
						if (items[i].type)
							items[i].type = items[i].type.split(" ")[0];
						break;
					}
				}
				if (!set) {
					// Couldn't find registered session for this editable time so it must be a free
					items[i].title = "Free";
				}
			}
		}
		return {
			"name": user.name,
			"schedule": items.map(formatter)
		};
	}
}
adminRouter.route("/schedule/:filter").get(async (request, response) => {
	response.send(await common.readFileAsync("public/components/admin/schedule.html"));
});
adminRouter.route("/schedule/:filter/data").get(async (request, response) => {
	let {filter}: { filter: string } = request.params;
	if (!filter) {
		filter = "all";
	}
	filter = filter.toString().toLowerCase();
	let criteria: string = "";
	if (filter === "all") {
		criteria = "";
	}
	else if (filter === "freshman") {
		criteria = "grade: 9";
	}
	else if (filter === "sophomore") {
		criteria = "grade: 10";
	}
	else if (filter === "junior") {
		criteria = "grade: 11";
	}
	else if (filter === "senior") {
		criteria = "grade: 12";
	}
	else {
		criteria = "type: {type}";
	}
	let type = common.getUserType(filter);
	try {
		type User = {
			name: string;
			username: string;
			registered: boolean;
		};
		let users: User[] = await common.cypherAsync({
			"query": `MATCH (u:User {${criteria}}) RETURN u.name AS name, u.username AS username, u.registered AS registered ORDER BY last(split(u.name, " "))`,
			"params": {
				type: common.getUserType(filter)
			}
		});
		let results = await Promise.all(users.map(user => {
			return getScheduleForUser(user);
		}));
		response.json(results);
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/schedule/user/:name").get(async (request, response) => {
	let {name}: { name: string } = request.params;
	response.send(await common.readFileAsync("public/components/admin/schedule.html"));
});
adminRouter.route("/schedule/user/:name/data").get(async (request, response) => {
	let {name}: { name: string } = request.params;

	try {
		let user = await common.cypherAsync({
			"query": "MATCH (u:User) WHERE u.name = {name} OR u.username = {name} RETURN u.name AS name, u.username AS username, u.registered AS registered",
			"params": {
				name: name
			}
		});
		let schedule: { name: string; schedule: any[] };
		if (user.length !== 1) {
			schedule = await getScheduleForUser({
				"name": "Unknown user",
				"username": "unknown",
				"registered": false
			});
		}
		else {
			schedule = await getScheduleForUser(user[0]);
		}
		// Wrap in an array because the schedule displayer is used for both lists of schedules and individual schedules
		response.json([schedule]);
	}
	catch (err) {
		common.handleError(response, err);
	}
});
/*adminRouter.route("/schedule/switch").patch(postParser, (request, response) => {
	let {id1, id2}: { id1: string, id2: string } = request.body;
	if (!id1 || !id2) {
		response.json({ "success": false, "message": "Missing IDs" });
		return;
	}
	Promise.map([id1, id2], function (id) {
		return common.cypherAsync({
			query: "MATCH (item:ScheduleItem {id: {id}}) RETURN item.id AS id, item.start AS start, item.end AS end",
			params: {
				id: id
			}
		});
	}).spread(function (item1, item2) {
		//if (item1.length !== 1 || !item2.length !== 1) {

		//}
	});
});*/
adminRouter.route("/schedule/date")
	.get(async (request, response) => {
		try {
			response.json({
				"formatted": (await common.getSymposiumDate()).format("MMMM Do, YYYY")
			});
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.patch(postParser, async (request, response) => {
		let rawDate: string = request.body.date;
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		rawDate = rawDate.toString().trim();
		if (!rawDate) {
			response.json({ "success": false, "message": "No date input" });
			return;
		}
		let date: moment.Moment = moment(rawDate, dateFormat);
		if (!date.isValid()) {
			response.json({ "success": false, "message": "Invalid date input" });
			return;
		}

		// Get all schedule items and sessions
		try {
			let [scheduleItems, sessions]: [any[], any[]] = await common.cypherAsync({
				queries: [{
					query: "MATCH (item:ScheduleItem) RETURN item.id AS id, item.start AS start, item.end AS end"
				}, {
					query: "MATCH (s:Session) RETURN s.slug AS slug, s.startTime AS start, s.endTime AS end"
				}]
			});
			scheduleItems.map(function (item) {
				let start = moment(item.start);
				let end = moment(item.end);
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				item.start = start.format();
				item.end = end.format();
				return item;
			});
			sessions.map(function (session) {
				let start = moment(session.start);
				let end = moment(session.end);
				start.set("year", date.get("year"));
				start.set("month", date.get("month"));
				start.set("date", date.get("date"));
				end.set("year", date.get("year"));
				end.set("month", date.get("month"));
				end.set("date", date.get("date"));
				session.start = start.format();
				session.end = end.format();
				return session;
			});
			let queries: any[] = [{
				query: "MATCH (c:Constant) WHERE c.date IS NOT NULL SET c.date = { date } RETURN c",
				params: {
					date: date.format("YYYY-MM-DD")
				}
			}];
			queries = queries.concat(scheduleItems.map(function (item) {
				return {
					query: "MATCH (item:ScheduleItem {id: {id}}) SET item.start = {start}, item.end = {end}",
					params: {
						id: item.id,
						start: item.start,
						end: item.end
					}
				};
			}));
			queries = queries.concat(sessions.map(function (session) {
				return {
					query: "MATCH (s:Session {slug: {slug}}) SET s.startTime = {start}, s.endTime = {end}",
					params: {
						slug: session.slug,
						start: session.start,
						end: session.end
					}
				};
			}));
			await common.cypherAsync({
				queries: queries
			});
			response.json({ "success": true, "message": "Symposium date changed successfully" });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/registration/email").get(async (request, response) => {
	try {
		let [registration, schedule] = await Promise.all([
			common.cypherAsync({
				query: "MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL RETURN c"
			}),
			common.cypherAsync({
				query: "MATCH (c:Constant) WHERE c.scheduleEmailTime IS NOT NULL RETURN c"
			})
		]);
		let registrationEmailTime: moment.Moment = moment(registration[0].c.properties.registrationEmailTime);
		let scheduleEmailTime: moment.Moment = moment(schedule[0].c.properties.scheduleEmailTime);
		response.json({
			"registration": {
				"raw": registration[0].c.properties.registrationEmailTime,
				"formatted": `${registrationEmailTime.format(dateFormat)} at ${registrationEmailTime.format(timeFormat)}`
			},
			"schedule": {
				"raw": schedule[0].c.properties.scheduleEmailTime,
				"formatted": `${scheduleEmailTime.format(dateFormat)} at ${scheduleEmailTime.format(timeFormat)}`
			}
		});
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/registration/email/registration").post(async (request, response) => {
	let totalRecipients = 0;
	// Get emails to send to
	try {
		let date = await common.getSymposiumDate();
		let results = await common.cypherAsync({
			"query": "MATCH (u:User) RETURN u.name AS name, u.username AS username, u.email AS email, u.code AS code"
		});
		totalRecipients = results.length;
		for (let user of results) {
			let email = (!!user.email) ? user.email : `${user.username}@gfacademy.org`;
			let emailToSend = new sendgrid.Email({
				to: email,
				from: "registration@wppsymposium.org",
				fromname: "GFA World Perspectives Symposium",
				subject: "GFA WPP Symposium Registration",
				text:
				`Hi ${user.name},

This year's World Perspectives Symposium will take place on ${date.format(dateFormat)}. To login and register for presentations, visit the following link:

https://wppsymposium.org/user/login/${user.code}

Be sure to register for presentations soon before they fill up. You can visit the link at any time after you've registered to view your schedule. If you miss the registration cut-off date, your schedule will be automatically generated based on availability.

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			});
			await new Promise<Object>((resolve, reject) => {
				sendgrid.send(emailToSend, (err: Error | null, json: Object) => {
					if (err) {
						reject(err);
					}
					else {
						resolve(json);
					}
				});
			});
		}
		await common.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.registrationEmailTime IS NOT NULL SET c.registrationEmailTime = {time} RETURN c",
			params: {
				time: moment().format()
			}
		});
		response.json({ "success": true, "message": `Sent registration emails to ${totalRecipients} recipients` });
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/registration/email/schedule").post(async (request, response) => {
	let totalRecipients = 0;
	// Get emails to send to
	try {
		let date = await common.getSymposiumDate();
		let results = await common.cypherAsync({
			"query": "MATCH (u:User) RETURN u.name AS name, u.username AS username, u.email AS email, u.code AS code, u.registered AS registered"
		});
		totalRecipients = results.length;
		for (let user of results) {
			let {schedule}: {schedule: any[]} = await getScheduleForUser({
				"name": user.name,
				"username": user.username,
				"registered": user.registered
			});
			// Generate schedule for email body
			let scheduleFormatted = schedule.map(function (scheduleItem) {
				return `${scheduleItem.time.start.formatted} to ${scheduleItem.time.end.formatted}${!!scheduleItem.location ? " in " + scheduleItem.location : ""}: ${scheduleItem.title}${!!scheduleItem.type ? ` (${scheduleItem.type})` : ""}`;
			}).join("\n\n");

			let email = (!!user.email) ? user.email : `${user.username}@gfacademy.org`;
			let emailToSend = new sendgrid.Email({
				to: email,
				from: "registration@wppsymposium.org",
				fromname: "GFA World Perspectives Symposium",
				subject: "Your symposium schedule",
				text:
				`Hi ${user.name},

Here is your schedule for this year's World Perspectives Symposium taking place on ${date.format("dddd")} ${date.format(dateFormat)}:

${scheduleFormatted}

You can also visit the following link to view and print a more detailed schedule: https://wppsymposium.org/user/login/${user.code}

Feel free to reply to this email if you're having any problems.

Thanks,
The GFA World Perspectives Team
`
			});
			await new Promise<Object>((resolve, reject) => {
				sendgrid.send(emailToSend, (err: Error | null, json: Object) => {
					if (err) {
						reject(err);
					}
					else {
						resolve(json);
					}
				});
			});
		}
		await common.cypherAsync({
			query: "MATCH (c:Constant) WHERE c.scheduleEmailTime IS NOT NULL SET c.scheduleEmailTime = {time} RETURN c",
			params: {
				time: moment().format()
			}
		});
		response.json({ "success": true, "message": `Sent schedule emails to ${totalRecipients} recipients` });
	}
	catch (err) {
		common.handleError(response, err);
	}
});
adminRouter.route("/registration/open")
	.get(async (request, response) => {
		try {
			let result = await common.cypherAsync({
				query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL RETURN c"
			});
			let registrationOpen: boolean = result[0].c.properties.registrationOpen;
			response.json({
				"open": registrationOpen
			});
		}
		catch (err) {
			common.handleError(response, err);
		}
	})
	.put(postParser, async (request, response) => {
		let {open}: { open: boolean } = request.body;
		if (typeof open !== "boolean") {
			response.json({ "success": false, "message": "Invalid open value" });
			return;
		}
		try {
			await common.cypherAsync({
				query: "MATCH (c:Constant) WHERE c.registrationOpen IS NOT NULL SET c.registrationOpen = {open} RETURN c",
				params: {
					open: open
				}
			});
			response.json({ "success": true, "message": `Registration is now ${open ? "open" : "closed"}` });
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/registration/stats")
	.get(async (request, response) => {
		try {
			let results: any[] = await common.cypherAsync({
				query: "MATCH (u:User) WHERE u.type = 0 OR u.type = 1 RETURN u.registered AS registered, u.type AS type"
			});
			let registeredStudents = 0;
			let totalStudents = 0;
			let registeredTeachers = 0;
			let totalTeachers = 0;
			results.forEach(function (result) {
				if (result.type === common.UserType.Student) {
					totalStudents++;
					if (result.registered)
						registeredStudents++;
				}
				if (result.type === common.UserType.Teacher) {
					totalTeachers++;
					if (result.registered)
						registeredTeachers++;
				}
			});
			response.json({
				"students": {
					"total": totalStudents,
					"registered": registeredStudents
				},
				"faculty": {
					"total": totalTeachers,
					"registered": registeredTeachers
				}
			});
		}
		catch (err) {
			common.handleError(response, err);
		}
	});
adminRouter.route("/registration/auto").post(async (request, response) => {
	let totalUsers = 0;
	// Get all unregistered users and all sessions first
	try {
		let [users, editablePeriods, sessions] = await Promise.all<User[], any[], any[]>([
			common.cypherAsync({
				query: "MATCH (u:User {registered: false}) RETURN u.username AS username"
			}),
			common.cypherAsync({
				query: "MATCH(item:ScheduleItem {editable: true }) RETURN item.title AS title, item.start AS startTime, item.end AS endTime"
			}),
			common.cypherAsync({
				query: "MATCH (s:Session) RETURN s.slug AS slug, s.attendees AS attendees, s.capacity AS capacity, s.startTime AS startTime, s.endTime AS endTime"
			})
		]);
		totalUsers = users.length;
		for (let period of editablePeriods) {
			function shuffle(array: any[]) {
				let counter = array.length;

				// While there are elements in the array
				while (counter > 0) {
					// Pick a random index
					let index = Math.floor(Math.random() * counter);

					// Decrease counter by 1
					counter--;

					// And swap the last element with it
					let temp = array[counter];
					array[counter] = array[index];
					array[index] = temp;
				}

				return array;
			}
			// Shuffle users for each period
			users = shuffle(users);
			// Find non-full sessions that occur at this time
			let availableSessions: any[] = [];
			function updateAvailableSessions() {
				availableSessions = sessions.filter(function (session) {
					if (session.attendees < session.capacity && moment(session.startTime).isSame(moment(period.startTime))) {
						return true;
					}
					return false;
				});
				if (availableSessions.length < 1) {
					// Not enough sessions
					console.warn(`Not enough capacity at ${moment(period.startTime).format(timeFormat)} to autoregister`);
				}
				function sortSessions(sessions: any[]): any[] {
					return sessions.sort(function (a, b) {
						return a.attendees - b.attendees;
					});
				}
				availableSessions = sortSessions(availableSessions);
			}
			updateAvailableSessions();
			// Find the unregistered users that have registered for this period already (partially completed registration) to filter them out of needing to be autoregistered
			let attendingUsers: User[] = await common.cypherAsync({
				query: "MATCH (u:User {registered: false})-[r:ATTENDS]->(s:Session {startTime: {startTime}}) RETURN u.username AS username",
				params: {
					startTime: period.startTime
				}
			});
			let attendingUsernames = attendingUsers.map(function (attendingUser) {
				return attendingUser.username;
			});
			let remainingUsers = users.filter(function (user) {
				return attendingUsernames.indexOf(user.username) === -1;
			});
			for (let user of remainingUsers) {
				updateAvailableSessions();
				// Check if this user moderates or presents a session at this time period
				let [presenting, moderating] = await Promise.all<any[], any[]>([
					common.cypherAsync({
						query: "MATCH (u:User {username: {username}})-[r:PRESENTS]->(s:Session {startTime: {startTime}}) RETURN s.slug AS slug",
						params: {
							username: user.username,
							startTime: period.startTime
						}
					}),
					common.cypherAsync({
						query: "MATCH (u:User {username: {username}})-[r:MODERATES]->(s:Session {startTime: {startTime}}) RETURN s.slug AS slug",
						params: {
							username: user.username,
							startTime: period.startTime
						}
					})
				]);
				let registerSlug = null;
				let attendanceCount = 1;
				if (presenting.length > 0) {
					registerSlug = presenting[0].slug;
					attendanceCount = 0;
				}
				else if (moderating.length > 0) {
					registerSlug = moderating[0].slug;
					attendanceCount = 0;
				}
				else {
					registerSlug = availableSessions[0].slug;
					availableSessions[0].attendees++;
				}
				// Register this user
				await common.cypherAsync({
					query: `
						MATCH (user:User {username: {username}})
						MATCH (session:Session {slug: {slug}})
						CREATE (user)-[r:ATTENDS]->(session)
						SET session.attendees = session.attendees + {attendanceCount}`,
					params: {
						username: user.username,
						slug: registerSlug,
						attendanceCount: attendanceCount
					}
				});
			}
		}
		
		// Set all users as registered
		await common.cypherAsync({
			query: "MATCH (u:User {registered: false}) SET u.registered = true"
		});
		response.json({ "success": true, "message": `Successfully autoregistered ${totalUsers} users` });
	}
	catch (err) {
		common.handleError(response, err);
	}
});
